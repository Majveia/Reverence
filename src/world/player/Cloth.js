// Player track — verlet cloth scarf (Journey-style), two tails anchored at the back of the neck wrap.
// World-space (planet-local, float64) particles; the mesh is re-centered on the character each frame so
// GPU positions stay small. Forces: gravity (spherical), aerodynamic pressure from the relative wind
// (world wind − particle velocity: streams behind when running/gliding), flutter noise. Constraints:
// structural + shear + bending, iterated; collisions against body proxy spheres (helmet, torso, pack).
import * as THREE from 'three';
import { clamp, noise1 } from './util.js';
import { heightToNormal } from './textures.js';

function scarfTexture(c1, c2) {
  const W = 64, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const hex = (c) => '#' + c.getHexString(THREE.SRGBColorSpace);
  ctx.fillStyle = hex(c1); ctx.fillRect(0, 0, W, H);
  // slow lengthwise dye variation (hand-dyed wool)
  for (let y = 0; y < H; y += 4) {
    const k = 0.5 + 0.5 * Math.sin(y * 0.071) * Math.sin(y * 0.023 + 1.3);
    ctx.fillStyle = `rgba(0,0,0,${0.1 * k})`; ctx.fillRect(0, y, W, 4);
  }
  // fine woven texture
  for (let y = 0; y < H; y += 2) { ctx.fillStyle = `rgba(0,0,0,${0.05 + 0.04 * ((y >> 1) & 1)})`; ctx.fillRect(0, y, W, 1); }
  for (let x = 0; x < W; x += 2) { ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fillRect(x, 0, 1, H); }
  // glyph band and stripes toward the tip (v → 1)
  ctx.fillStyle = hex(c2);
  ctx.fillRect(0, H * 0.72, W, 3); ctx.fillRect(0, H * 0.88, W, 3);
  ctx.globalAlpha = 0.9;
  for (let i = 0; i < 5; i++) {
    const y = H * 0.75 + i * 7;
    const x = 10 + (i % 2) * 8;
    ctx.fillRect(x, y, 6, 3); ctx.fillRect(x + 14, y, 3, 6); ctx.fillRect(x + 24, y + 2, 8, 2); ctx.fillRect(x + 36, y, 3, 5);
  }
  ctx.globalAlpha = 1;
  // edge hems
  ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(0, 0, 3, H); ctx.fillRect(W - 3, 0, 3, H);
  // fringe: the last 8% are loose threads (alpha-tested), knotted in bundles
  const f0 = Math.round(H * 0.92);
  ctx.clearRect(0, f0, W, H - f0);
  for (let x = 1; x < W - 1; x += 3) {
    const len = (H - f0) * (0.55 + 0.45 * Math.abs(Math.sin(x * 12.9898) * 43758.5453 % 1));
    ctx.fillStyle = hex(c1); ctx.fillRect(x, f0, 2, len);
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(x + 1, f0, 1, len);
  }
  ctx.fillStyle = hex(c2); ctx.fillRect(0, f0 - 3, W, 3); // knot band
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Wool weave + soft lengthwise creases → normal map (tangent space, uv of the strip). */
function scarfNormal() {
  const W = 64, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const weave = 0.5 + 0.18 * Math.sin(x * Math.PI) * Math.sin(y * Math.PI * 0.5) + 0.12 * Math.sin((x + y) * Math.PI * 0.5);
    const crease = 0.2 * Math.sin(x / W * Math.PI * 3 + Math.sin(y * 0.05) * 1.5) * (0.6 + 0.4 * Math.sin(y * 0.03));
    const v = Math.max(0, Math.min(255, (weave + crease) * 200)) | 0;
    const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(heightToNormal(cv, 1.2, true));
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
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
  constructor(world, palette, quality) {
    this.world = world;
    const q = quality?.tier === 'low' ? 0.7 : 1;
    this.strips = [new Strip(3, Math.round(13 * q), 0.16, 1.05, 0.3), new Strip(3, Math.round(9 * q), 0.12, 0.7, 0.3)];
    // anchors in chest space (back of the neck wrap)
    this.anchorsC = [
      [new THREE.Vector3(-0.02, 0.215, -0.1), new THREE.Vector3(0.05, 0.22, -0.095), new THREE.Vector3(0.12, 0.215, -0.07)],
      [new THREE.Vector3(-0.1, 0.205, -0.085), new THREE.Vector3(-0.05, 0.215, -0.1), new THREE.Vector3(0.0, 0.21, -0.105)],
    ];
    this.origin = new THREE.Vector3();
    this.group = new THREE.Group();
    this.group.name = 'scarf';
    this.tex = null;
    try { this.tex = scarfTexture(palette.scarf, palette.scarf2); } catch (_) { this.tex = null; }
    const hi = quality?.tier !== 'low';
    let nrm = null;
    try { nrm = scarfNormal(); } catch (_) { nrm = null; }
    this.material = new (hi ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial)({
      color: this.tex ? 0xffffff : palette.scarf, map: this.tex, roughness: 0.88, side: THREE.DoubleSide,
      normalMap: nrm, normalScale: new THREE.Vector2(0.8, 0.8), alphaTest: this.tex ? 0.5 : 0,
    });
    // wool: a soft sheen in the scarf's own (lighter, more saturated) hue — never a pink/white film
    if (hi) {
      const hsl = {}; palette.scarf.getHSL(hsl);
      this.material.sheen = 0.45; this.material.sheenRoughness = 0.55;
      this.material.sheenColor = new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.1), Math.min(0.6, hsl.l * 1.35 + 0.05));
    }
    this.meshes = [];
    for (const s of this.strips) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(s.n * 3), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(s.nrm, 3));
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
    for (let i = 0; i < 7; i++) this.spheres.push({ c: new THREE.Vector3(), r: 0.1 });
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
    const gg = g * 0.55; // light silk: stylised float (Journey)
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
          const fq = 3 + Math.min(this._air || 0, 25) * 0.45;
          const ci = pi - j * s.cols; // column: edges flap out of phase → the ribbon twists instead of planking
          const fl = Math.sin(this.t * fq - j * 1.15 + k * 2.1 + (ci - 1) * 0.55) * 0.75 + noise1(this.t * 2.3 + j * 0.9 + k * 5.1, 7 + k) * 0.6;
          let rx = wind.x - vx, ry = wind.y - vy, rz = wind.z - vz;
          const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
          // pressure along the normal + tangential drag (ribbons stream downwind), flutter
          const nx = N[o], ny = N[o + 1], nz = N[o + 2];
          const vn = rx * nx + ry * ny + rz * nz;
          const kN = 1.6, kT = 0.28, flK = 0.7 + 0.055 * Math.min(rl, 25); // livelier flutter at speed
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
      // upload (relative to center)
      const pos = this.meshes[k].geometry.attributes.position;
      const arr = pos.array;
      for (let pi = 0; pi < s.n; pi++) {
        const o = pi * 3;
        arr[o] = X[o] - center.x; arr[o + 1] = X[o + 1] - center.y; arr[o + 2] = X[o + 2] - center.z;
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
