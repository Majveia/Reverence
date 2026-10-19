// Player track — verlet cloth scarf (Journey-style), two tails anchored at the back of the neck wrap.
// World-space (planet-local, float64) particles; the mesh is re-centered on the character each frame so
// GPU positions stay small. Forces: gravity (spherical), aerodynamic pressure from the relative wind
// (world wind − particle velocity: streams behind when running/gliding), flutter noise. Constraints:
// structural + shear + bending, iterated; collisions against body proxy spheres (helmet, torso, pack).
import * as THREE from 'three';
import { clamp, noise1 } from './util.js';
import { heightToNormal } from './textures.js';

function scarfTexture(c1, c2) {
  const W = 128, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const hex = (c) => '#' + c.getHexString(THREE.SRGBColorSpace);
  ctx.fillStyle = hex(c1); ctx.fillRect(0, 0, W, H);
  // hand-dyed wool: slow, irregular lengthwise dye clouds (no regular stripes — they read as banding)
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 70; i++) {
    const x = rnd() * W, y = rnd() * H, rx = 20 + rnd() * 50, ry = 30 + rnd() * 90, d = rnd() < 0.5;
    const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
    g.addColorStop(0, d ? 'rgba(40,0,0,0.12)' : 'rgba(255,120,90,0.07)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save(); ctx.translate(x, y); ctx.scale(rx / Math.max(rx, ry), ry / Math.max(rx, ry)); ctx.translate(-x, -y);
    ctx.fillStyle = g; ctx.fillRect(x - Math.max(rx, ry), y - Math.max(rx, ry), Math.max(rx, ry) * 2, Math.max(rx, ry) * 2);
    ctx.restore();
  }
  // fibre noise (per pixel, fine enough to vanish into the weave normal map at any distance)
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const k = 0.93 + rnd() * 0.12; d[i] *= k; d[i + 1] *= k; d[i + 2] *= k; }
  ctx.putImageData(img, 0, 0);
  // woven glyph band toward the tip (v → 1): a few small motifs in the gold thread
  ctx.fillStyle = hex(c2);
  ctx.fillRect(0, H * 0.78, W, 3);
  ctx.globalAlpha = 0.85;
  for (let i = 0; i < 4; i++) {
    const y = H * 0.8 + i * 10, x = 18 + (i % 2) * 14;
    ctx.fillRect(x, y, 10, 4); ctx.fillRect(x + 24, y, 4, 8); ctx.fillRect(x + 44, y + 2, 12, 3); ctx.fillRect(x + 66, y, 4, 7);
  }
  ctx.globalAlpha = 1;
  // edge hems
  ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(0, 0, 4, H); ctx.fillRect(W - 4, 0, 4, H);
  // fringe: the last 7 % are loose threads (alpha-tested), knotted in bundles
  const f0 = Math.round(H * 0.93);
  ctx.clearRect(0, f0, W, H - f0);
  for (let x = 2; x < W - 2; x += 4) {
    const len = (H - f0) * (0.55 + 0.45 * Math.abs(Math.sin(x * 12.9898) * 43758.5453 % 1));
    ctx.fillStyle = hex(c1); ctx.fillRect(x, f0, 3, len);
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(x + 2, f0, 1, len);
  }
  ctx.fillStyle = hex(c2); ctx.fillRect(0, f0 - 4, W, 4); // knot band
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Wool weave + soft lengthwise creases → normal map (tangent space, uv of the strip). */
function scarfNormal() {
  const W = 128, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // knit: V-shaped stitches in columns (fine), plus soft lengthwise creases
    const col = (x % 4) / 4, row = (y % 4) / 4;
    const vst = 1 - Math.abs((col - 0.5) * 2 - (row - 0.5) * (x % 8 < 4 ? 1 : -1));
    const weave = 0.5 + 0.16 * vst + 0.05 * Math.sin((x * 0.7 + y * 0.31));
    const crease = 0.2 * Math.sin(x / W * Math.PI * 3 + Math.sin(y * 0.025) * 1.5) * (0.6 + 0.4 * Math.sin(y * 0.015));
    const v = Math.max(0, Math.min(255, (weave + crease) * 200)) | 0;
    const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(heightToNormal(cv, 1.2, true));
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Hair lock: dark strands with lighter combed highlights, clumped, tapering tip (alpha-tested). */
function hairTexture(c1, c2) {
  const W = 64, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const hex = (c) => '#' + c.getHexString(THREE.SRGBColorSpace);
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  ctx.clearRect(0, 0, W, H);
  // strands: each a 1-2 px line running the length, ending at its own length (clumped tips)
  for (let i = 0; i < 150; i++) {
    const x = rnd() * W, w = 1 + rnd() * 1.6;
    const clump = Math.floor(x / 9);
    const len = H * (0.72 + 0.26 * Math.abs(Math.sin(clump * 3.7 + 1.1)) - rnd() * 0.08);
    const edge = Math.min(x, W - x) / (W * 0.5);           // the lock thins toward its edges
    const l2 = len * (0.55 + 0.45 * Math.sqrt(edge));
    const g = ctx.createLinearGradient(0, 0, 0, l2);
    const k = rnd();
    const base = k < 0.15 ? hex(c2) : hex(c1);
    g.addColorStop(0, base); g.addColorStop(0.85, base); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.strokeStyle = g; ctx.lineWidth = w;
    ctx.beginPath();
    const sway = (rnd() - 0.5) * 6;
    ctx.moveTo(x, 0); ctx.bezierCurveTo(x + sway, l2 * 0.3, x - sway, l2 * 0.6, x + sway * 0.5 + (W / 2 - x) * 0.25, l2);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.flipY = false; // canvas top = the root (v = 0 at the tie)
  return t;
}

class Strip {
  constructor(cols, rows, width, length, taper) {
    this.cols = cols; this.rows = rows; this.width = width; this.seg = length / (rows - 1); this.taper = taper;
    const n = cols * rows;
    this.n = n;
    this.x = new Float64Array(n * 3); this.p = new Float64Array(n * 3);
    this.nrm = new Float32Array(n * 3);
    this.inv = new Float32Array(n).fill(1);
    for (let i = 0; i < cols; i++) this.inv[i] = 0; // first row pinned
    this.cons = [];
    const idx = (i, j) => j * cols + i;
    const w = (j) => width * (1 - taper * (j / (rows - 1)));
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const dx = w(j) / (cols - 1);
      if (i < cols - 1) this.cons.push(idx(i, j), idx(i + 1, j), dx, 1);
      if (j < rows - 1) this.cons.push(idx(i, j), idx(i, j + 1), this.seg, 1);
      if (i < cols - 1 && j < rows - 1) {
        const d = Math.hypot(dx, this.seg);
        this.cons.push(idx(i, j), idx(i + 1, j + 1), d, 0.6);
        this.cons.push(idx(i + 1, j), idx(i, j + 1), d, 0.6);
      }
      if (j < rows - 2) this.cons.push(idx(i, j), idx(i, j + 2), this.seg * 2, 0.35);
    }
    this.cons = new Float64Array(this.cons);
  }
}

export class Scarf {
  /**
   * kind 'scarf' (default): two long red silk-wool tails from the back of the neck (chest-space anchors).
   * kind 'hair': the ponytail — three dark locks from the tie at the back of the crown (head-space anchors),
   * heavier and calmer than the scarf (less flutter), same solver.
   */
  constructor(world, palette, quality, kind = 'scarf') {
    this.world = world;
    this.kind = kind;
    const q = quality?.tier === 'low' ? 0.7 : 1;
    const hairK = kind === 'hair';
    if (hairK) {
      this.strips = [new Strip(3, Math.round(15 * q), 0.085, 0.66, 0.6), new Strip(3, Math.round(12 * q), 0.06, 0.52, 0.62), new Strip(3, Math.round(11 * q), 0.055, 0.46, 0.62)];
      // anchors in head space (around the ponytail tie, relative to the head bone at y 1.585)
      const ty = 0.165, tz = -0.104;
      this.anchorsC = [
        [new THREE.Vector3(0.026, ty, tz), new THREE.Vector3(0.0, ty + 0.006, tz - 0.004), new THREE.Vector3(-0.026, ty, tz)],
        [new THREE.Vector3(0.03, ty - 0.012, tz + 0.01), new THREE.Vector3(0.012, ty - 0.004, tz - 0.002), new THREE.Vector3(-0.008, ty - 0.012, tz + 0.006)],
        [new THREE.Vector3(0.006, ty - 0.012, tz + 0.006), new THREE.Vector3(-0.012, ty - 0.004, tz - 0.002), new THREE.Vector3(-0.03, ty - 0.012, tz + 0.01)],
      ];
      this.gK = 0.95; this.flK = 0.35; this.aeroK = 0.55; this.cupK = 0.35;
    } else {
      // two generous tails (the one warm accent of the silhouette), tapering
      this.strips = [new Strip(3, Math.round(18 * q), 0.17, 1.3, 0.45), new Strip(3, Math.round(13 * q), 0.135, 0.92, 0.45)];
      // anchors in chest space (back of the loose neck wrap)
      this.anchorsC = [
        [new THREE.Vector3(-0.02, 0.24, -0.1), new THREE.Vector3(0.05, 0.245, -0.096), new THREE.Vector3(0.11, 0.236, -0.075)],
        [new THREE.Vector3(-0.11, 0.232, -0.08), new THREE.Vector3(-0.055, 0.242, -0.098), new THREE.Vector3(0.0, 0.24, -0.104)],
      ];
      this.gK = 0.55; this.flK = 1; this.aeroK = 1; this.cupK = 1;
    }
    this.origin = new THREE.Vector3();
    this.group = new THREE.Group();
    this.group.name = kind;
    this.tex = null;
    try { this.tex = hairK ? hairTexture(palette.hair, palette.hairHi) : scarfTexture(palette.scarf, palette.scarf2); } catch (_) { this.tex = null; }
    const hi = quality?.tier !== 'low';
    let nrm = null;
    try { nrm = scarfNormal(); } catch (_) { nrm = null; }
    this.material = new (hi ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial)({
      color: this.tex ? 0xffffff : hairK ? palette.hair : palette.scarf, map: this.tex, roughness: hairK ? 0.45 : 0.86, side: THREE.DoubleSide,
      normalMap: hairK ? null : nrm, normalScale: new THREE.Vector2(0.8, 0.8), alphaTest: this.tex ? 0.5 : 0,
    });
    if (hi) {
      if (hairK) { this.material.sheen = 1; this.material.sheenRoughness = 0.3; this.material.sheenColor = new THREE.Color(palette.hairHi).multiplyScalar(1.5); }
      else { // silk-wool: a soft sheen in the scarf's own (lighter, more saturated) hue — never a pink/white film
        const hsl = {}; palette.scarf.getHSL(hsl);
        this.material.sheen = 0.5; this.material.sheenRoughness = 0.5;
        this.material.sheenColor = new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.1), Math.min(0.6, hsl.l * 1.35 + 0.05));
      }
    }
    if (hairK && nrm) nrm.dispose();
    this.meshes = [];
    for (const s of this.strips) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(s.n * 3), 3));
      s.rnrm = new Float32Array(s.n * 3); // render normals (cupped cross-section), physics keeps s.nrm
      g.setAttribute('normal', new THREE.BufferAttribute(s.rnrm, 3));
      const uv = new Float32Array(s.n * 2);
      for (let j = 0; j < s.rows; j++) for (let i = 0; i < s.cols; i++) { uv[(j * s.cols + i) * 2] = i / (s.cols - 1); uv[(j * s.cols + i) * 2 + 1] = j / (s.rows - 1); }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      const idx = [];
      for (let j = 0; j < s.rows - 1; j++) for (let i = 0; i < s.cols - 1; i++) {
        const a = j * s.cols + i, b = a + 1, c = a + s.cols, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
      g.setIndex(idx);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);
      const m = new THREE.Mesh(g, this.material);
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
      this.group.add(m);
      this.meshes.push(m);
    }
    this.spheres = []; // {c: Vector3, r}
    for (let i = 0; i < 10; i++) this.spheres.push({ c: new THREE.Vector3(), r: 0.1 });
    this.initialized = false;
    this._a = new THREE.Vector3(); this._b = new THREE.Vector3(); this._n = new THREE.Vector3();
    this.t = 0;
  }

  /** Place all particles hanging from the anchors (after teleports / first frame). */
  reset(anchorsW, down) {
    for (let k = 0; k < this.strips.length; k++) {
      const s = this.strips[k], A = anchorsW[k];
      for (let j = 0; j < s.rows; j++) for (let i = 0; i < s.cols; i++) {
        const a = A[i];
        const o = (j * s.cols + i) * 3;
        s.x[o] = a.x + down.x * s.seg * j; s.x[o + 1] = a.y + down.y * s.seg * j; s.x[o + 2] = a.z + down.z * s.seg * j;
        s.p[o] = s.x[o]; s.p[o + 1] = s.x[o + 1]; s.p[o + 2] = s.x[o + 2];
      }
    }
    this.initialized = true;
  }

  /**
   * @param dt
   * @param anchorsW  [[Vector3 x3], [Vector3 x3]] planet-local anchor points
   * @param up        local up (unit)
   * @param g         gravity (m/s²)
   * @param wind      world wind velocity (m/s)
   * @param spheres   body collision spheres (planet-local), array of {c, r}
   * @param center    mesh origin (planet-local)
   */
  update(dt, anchorsW, up, g, wind, spheres, center) {
    this.t += dt;
    // strength of the airflow over the scarf (drives flutter frequency); from the tail tip's velocity
    { const s0 = this.strips[0], o = (s0.n - 1) * 3; const vx = (s0.x[o] - s0.p[o]), vy = (s0.x[o + 1] - s0.p[o + 1]), vz = (s0.x[o + 2] - s0.p[o + 2]);
      const h0 = Math.max(dt, 1e-3) / (dt > 1 / 45 ? 3 : 2);
      const rx = wind.x - vx / h0, ry = wind.y - vy / h0, rz = wind.z - vz / h0;
      this._air = Number.isFinite(rx + ry + rz) ? Math.sqrt(rx * rx + ry * ry + rz * rz) : 0; }
    if (!this.initialized) this.reset(anchorsW, this._n.copy(up).negate());
    const steps = dt > 1 / 45 ? 3 : 2;
    const h = Math.min(dt, 1 / 20) / steps;
    const gg = g * this.gK; // light silk: stylised float (Journey); hair is heavier
    const gx = -up.x * gg, gy = -up.y * gg, gz = -up.z * gg;
    for (let k = 0; k < this.strips.length; k++) {
      const s = this.strips[k], A = anchorsW[k];
      const X = s.x, Pp = s.p, N = s.nrm;
      for (let st = 0; st < steps; st++) {
        // pin anchors (interpolate across substeps is overkill; direct pin)
        for (let i = 0; i < s.cols; i++) { const o = i * 3; X[o] = A[i].x; X[o + 1] = A[i].y; X[o + 2] = A[i].z; Pp[o] = X[o]; Pp[o + 1] = X[o + 1]; Pp[o + 2] = X[o + 2]; }
        for (let pi = s.cols; pi < s.n; pi++) {
          const o = pi * 3;
          const vx = (X[o] - Pp[o]) / h, vy = (X[o + 1] - Pp[o + 1]) / h, vz = (X[o + 2] - Pp[o + 2]) / h;
          // relative air velocity
          const j = Math.floor(pi / s.cols);
          // travelling flutter wave down the tail (faster & tighter in strong airflow) + turbulence
          const fq = (3 + Math.min(this._air || 0, 25) * 0.45) * (this.kind === 'hair' ? 0.7 : 1);
          const ci = pi - j * s.cols; // column: edges flap out of phase → the ribbon twists instead of planking
          const fl = (Math.sin(this.t * fq - j * 1.15 + k * 2.1 + (ci - 1) * 0.55) * 0.75 + noise1(this.t * 2.3 + j * 0.9 + k * 5.1, 7 + k) * 0.6) * (0.45 + 1.1 * j / (s.rows - 1)) * this.flK; // flag-like: the wave grows toward the free end
          let rx = wind.x - vx, ry = wind.y - vy, rz = wind.z - vz;
          const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
          // pressure along the normal + tangential drag (ribbons stream downwind), flutter
          const nx = N[o], ny = N[o + 1], nz = N[o + 2];
          const vn = rx * nx + ry * ny + rz * nz;
          const kN = 1.6 * this.aeroK, kT = 0.36 * this.aeroK, flK = 0.7 + 0.055 * Math.min(rl, 25); // livelier flutter at speed
          let ax = gx + (vn * nx * kN + rx * kT) * Math.min(rl, 30) * 0.3 + nx * fl * Math.min(rl, 25) * flK;
          let ay = gy + (vn * ny * kN + ry * kT) * Math.min(rl, 30) * 0.3 + ny * fl * Math.min(rl, 25) * flK;
          let az = gz + (vn * nz * kN + rz * kT) * Math.min(rl, 30) * 0.3 + nz * fl * Math.min(rl, 25) * flK;
          const damp = 0.985;
          const nxp = X[o] + (X[o] - Pp[o]) * damp + ax * h * h;
          const nyp = X[o + 1] + (X[o + 1] - Pp[o + 1]) * damp + ay * h * h;
          const nzp = X[o + 2] + (X[o + 2] - Pp[o + 2]) * damp + az * h * h;
          Pp[o] = X[o]; Pp[o + 1] = X[o + 1]; Pp[o + 2] = X[o + 2];
          X[o] = nxp; X[o + 1] = nyp; X[o + 2] = nzp;
        }
        // constraints
        const C = s.cons, inv = s.inv;
        for (let it = 0; it < 4; it++) {
          for (let c = 0; c < C.length; c += 4) {
            const a = C[c] * 3, b = C[c + 1] * 3, rest = C[c + 2], stiff = C[c + 3];
            const dx = X[b] - X[a], dy = X[b + 1] - X[a + 1], dz = X[b + 2] - X[a + 2];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
            const wa = inv[C[c]], wb = inv[C[c + 1]], ws = wa + wb;
            if (ws === 0) continue;
            const diff = ((d - rest) / d) * stiff / ws;
            X[a] += dx * diff * wa; X[a + 1] += dy * diff * wa; X[a + 2] += dz * diff * wa;
            X[b] -= dx * diff * wb; X[b + 1] -= dy * diff * wb; X[b + 2] -= dz * diff * wb;
          }
          // collisions
          for (let pi = s.cols; pi < s.n; pi++) {
            const o = pi * 3;
            for (let q = 0; q < spheres.length; q++) {
              const sp = spheres[q];
              const dx = X[o] - sp.c.x, dy = X[o + 1] - sp.c.y, dz = X[o + 2] - sp.c.z;
              const d2 = dx * dx + dy * dy + dz * dz, r = sp.r + 0.012;
              if (d2 < r * r) {
                const d = Math.sqrt(d2) || 1e-6, k2 = (r - d) / d;
                X[o] += dx * k2; X[o + 1] += dy * k2; X[o + 2] += dz * k2;
              }
            }
          }
        }
        // safety: stretch limit (teleports / huge accelerations)
        for (let pi = s.cols; pi < s.n; pi++) {
          const o = pi * 3, a0 = (pi % s.cols) * 3;
          const dx = X[o] - X[a0], dy = X[o + 1] - X[a0 + 1], dz = X[o + 2] - X[a0 + 2];
          const lim = s.seg * s.rows * 1.15;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > lim * lim || !Number.isFinite(d2)) { this.initialized = false; }
        }
      }
      // normals
      const cols = s.cols;
      for (let j = 0; j < s.rows; j++) for (let i = 0; i < cols; i++) {
        const pi = j * cols + i, o = pi * 3;
        const iL = Math.max(0, i - 1), iR = Math.min(cols - 1, i + 1), jD = Math.max(0, j - 1), jU = Math.min(s.rows - 1, j + 1);
        const ox = (j * cols + iR) * 3, oy = (j * cols + iL) * 3, oa = (jU * cols + i) * 3, ob = (jD * cols + i) * 3;
        const tx = X[ox] - X[oy], ty = X[ox + 1] - X[oy + 1], tz = X[ox + 2] - X[oy + 2];
        const bx = X[oa] - X[ob], by = X[oa + 1] - X[ob + 1], bz = X[oa + 2] - X[ob + 2];
        let nx = ty * bz - tz * by, ny = tz * bx - tx * bz, nz = tx * by - ty * bx;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        N[o] = nx / l; N[o + 1] = ny / l; N[o + 2] = nz / l;
      }
      // upload (relative to center). Render-only cupped cross-section: the middle column rides out along the
      // normal and the edge normals tilt outward, so the band reads as soft wool with a lengthwise fold,
      // not a flat ribbon (the cup relaxes toward the free end and flips with the flutter).
      const pos = this.meshes[k].geometry.attributes.position;
      const arr = pos.array, RN = s.rnrm;
      for (let pi = 0; pi < s.n; pi++) {
        const o = pi * 3;
        arr[o] = X[o] - center.x; arr[o + 1] = X[o + 1] - center.y; arr[o + 2] = X[o + 2] - center.z;
        RN[o] = N[o]; RN[o + 1] = N[o + 1]; RN[o + 2] = N[o + 2];
      }
      if (cols === 3) {
        for (let j = 1; j < s.rows; j++) {
          const r0 = j * 3 * 3, r1 = r0 + 3, r2 = r0 + 6;
          let lx = X[r2] - X[r0], ly = X[r2 + 1] - X[r0 + 1], lz = X[r2 + 2] - X[r0 + 2];
          const ll = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1; lx /= ll; ly /= ll; lz /= ll;
          const u = j / (s.rows - 1);
          const cup = (ll * (0.2 - 0.1 * u) * Math.sin(this.t * 2.1 + j * 0.7 + k * 1.7) * 0.5 + ll * 0.12 * (1 - u)) * this.cupK;
          arr[r1] += N[r1] * cup; arr[r1 + 1] += N[r1 + 1] * cup; arr[r1 + 2] += N[r1 + 2] * cup;
          const tilt = Math.max(-0.9, Math.min(0.9, cup / (ll * 0.5) * 1.6));
          for (const [o, sg] of [[r0, -1], [r2, 1]]) {
            let nx = N[o] + sg * lx * tilt, ny = N[o + 1] + sg * ly * tilt, nz = N[o + 2] + sg * lz * tilt;
            const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            RN[o] = nx / nl; RN[o + 1] = ny / nl; RN[o + 2] = nz / nl;
          }
        }
      }
      pos.needsUpdate = true;
      this.meshes[k].geometry.attributes.normal.needsUpdate = true;
    }
    this.group.position.copy(center);
    if (!this.initialized) this.reset(anchorsW, this._n.copy(up).negate());
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
    this.material.dispose();
    this.tex?.dispose();
    this.material.normalMap?.dispose();
  }
}
