// Player track — the long coat's skirt: verlet cloth hung from the waist (below the belt) in four panels with
// an open front, a back vent and side slits, so it parts around striding legs, streams back in the airflow
// when running / gliding, drapes onto the ground when the explorer sits, and moves in the wind at rest.
//
// World-space (planet-local) particles; the mesh is re-centred on the character each frame. Forces: gravity
// (spherical), relative-air pressure + drag, a soft gust flutter. Constraints: structural / shear / bend per
// panel, panel ties (sewn rows), a weak shape memory toward the rest drape in hip space (keeps an A-line
// instead of a crumpled tube), a max-distance leash, capsule collisions against the legs / pelvis / pack, and
// a ground plane. ~240 particles, allocation-free per frame.
import * as THREE from 'three';
import { B, REST_POS } from './Explorer.js';
import { patchLighting } from './Explorer.js';
import { getTextures } from './textures.js';
import { noise1 } from './util.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion();

function coatTexture(c1, c2, trim) {
  const W = 256, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const hex = (c) => '#' + c.getHexString(THREE.SRGBColorSpace);
  ctx.fillStyle = hex(c1); ctx.fillRect(0, 0, W, H);
  // soft vertical fold shading (wool hangs in loose pleats) + dye unevenness
  for (let x = 0; x < W; x++) {
    const k = 0.5 + 0.5 * Math.sin(x * 0.19) * Math.sin(x * 0.051 + 1.1);
    ctx.fillStyle = `rgba(0,0,0,${0.09 * k})`; ctx.fillRect(x, 0, 1, H);
  }
  for (let i = 0; i < 40; i++) {
    const x = (i * 97) % W, y = (i * 53) % H, r = 10 + (i % 7) * 4;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${i % 2 ? 255 : 0},${i % 2 ? 240 : 0},${i % 2 ? 220 : 0},0.035)`); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // hem band (bottom), a stitched trim line above it, the frayed hem edge (alpha)
  ctx.fillStyle = hex(c2); ctx.fillRect(0, H * 0.88, W, H * 0.12);
  ctx.fillStyle = hex(trim); ctx.fillRect(0, H * 0.84, W, 2); ctx.fillRect(0, H * 0.965, W, 1);
  for (let x = 0; x < W; x += 6) { ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(x, H * 0.86, 3, 1); }
  // dust darkens the lowest part of the hem (walked through the world)
  const gr = ctx.createLinearGradient(0, H * 0.7, 0, H);
  gr.addColorStop(0, 'rgba(70,58,44,0)'); gr.addColorStop(1, 'rgba(70,58,44,0.12)');
  ctx.fillStyle = gr; ctx.fillRect(0, H * 0.7, W, H * 0.3);
  ctx.clearRect(0, H - 3, W, 3);
  for (let x = 0; x < W; x += 2) { const l = 1 + ((x * 7919) % 5); ctx.fillStyle = hex(c2); ctx.fillRect(x, H - 3, 1, Math.min(3, l)); }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class Coat {
  constructor(palette, quality) {
    const lo = quality?.tier === 'low';
    this.rows = lo ? 7 : 10;
    this.cols = lo ? 4 : 6;
    this.len = 0.66;                        // waist → hem (mid-calf)
    this.seg = this.len / (this.rows - 1);
    this.y0 = 0.962;                        // pin ring height (group space, under the belt)
    this.rx = 0.18; this.rz = 0.128;
    // panels by angle (a = 0 front, +π/2 = left): open front, back vent, side slits
    const fo = 0.2;
    this.panels = [
      [fo, Math.PI * 0.5], [Math.PI * 0.5, Math.PI], [Math.PI, Math.PI * 1.5], [Math.PI * 1.5, Math.PI * 2 - fo],
    ];
    const P = this.panels.length, C = this.cols, Rr = this.rows;
    this.n = P * C * Rr;
    const n = this.n;
    this.x = new Float64Array(n * 3); this.p = new Float64Array(n * 3);
    this.inv = new Float32Array(n).fill(1);
    this.rest = new Float32Array(n * 3);    // rest drape in hips-bone space
    this.nrm = new Float32Array(n * 3);
    const idx = (pi, c, r) => (pi * Rr + r) * C + c;
    this.idx = idx;
    for (let pi = 0; pi < P; pi++) {
      const [a0, a1] = this.panels[pi];
      for (let r = 0; r < Rr; r++) for (let c = 0; c < C; c++) {
        const a = a0 + (a1 - a0) * (c / (C - 1));
        const t = r / (Rr - 1);
        const flare = 1 + 0.32 * t + 0.1 * t * t;  // A-line
        const back = Math.max(0, -Math.cos(a));     // the back hangs a little further out (over the seat)
        const i = idx(pi, c, r);
        this.rest[i * 3] = Math.sin(a) * this.rx * flare * (1 + 0.05 * back);
        // the back falls longer than the front (a swallow-tail duster line): one large shape that moves in the wind
        const kA = 1 + 0.26 * Math.pow(back, 1.6);
        this.rest[i * 3 + 1] = this.y0 - this.seg * kA * r * (1 - 0.06 * t) - REST_POS.hips.y;
        this.rest[i * 3 + 2] = Math.cos(a) * this.rz * flare * (1 + 0.25 * back * t);
        if (r === 0) this.inv[i] = 0;
      }
    }
    // constraints [a, b, rest, stiffness]
    const cons = [];
    const L = (a, b) => Math.hypot(this.rest[a * 3] - this.rest[b * 3], this.rest[a * 3 + 1] - this.rest[b * 3 + 1], this.rest[a * 3 + 2] - this.rest[b * 3 + 2]);
    const add = (a, b, k) => cons.push(a, b, L(a, b), k);
    for (let pi = 0; pi < P; pi++) {
      for (let r = 0; r < Rr; r++) for (let c = 0; c < C; c++) {
        const i = idx(pi, c, r);
        if (c < C - 1) add(i, idx(pi, c + 1, r), 1);
        if (r < Rr - 1) add(i, idx(pi, c, r + 1), 1);
        if (c < C - 1 && r < Rr - 1) { add(i, idx(pi, c + 1, r + 1), 0.5); add(idx(pi, c + 1, r), idx(pi, c, r + 1), 0.5); }
        if (r < Rr - 2) add(i, idx(pi, c, r + 2), 0.4);
        if (c < C - 2) add(i, idx(pi, c + 2, r), 0.25);
      }
    }
    // sewn panel edges: sides tied for the upper 40 %, the back vent for the upper 55 %
    const tie = (pa, pb, rows) => { for (let r = 1; r < rows; r++) cons.push(idx(pa, C - 1, r), idx(pb, 0, r), 0, 0.9); };
    tie(0, 1, Math.round(Rr * 0.4)); tie(1, 2, Math.round(Rr * 0.55)); tie(2, 3, Math.round(Rr * 0.4));
    this.cons = new Float64Array(cons);
    // capsules (planet-local, filled each frame): pelvis, thighs, shins, pack bottom
    this.caps = [];
    for (let i = 0; i < 6; i++) this.caps.push({ a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0.1 });
    this.ground = { p: new THREE.Vector3(), n: new THREE.Vector3(0, 1, 0), on: false };
    this.t = 0;
    this.initialized = false;

    // ---- mesh
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.rn = new Float32Array(n * 3);
    g.setAttribute('normal', new THREE.BufferAttribute(this.rn, 3));
    const uv = new Float32Array(n * 2), uv1 = new Float32Array(n * 2);
    for (let pi = 0; pi < P; pi++) {
      const [a0, a1] = this.panels[pi];
      for (let r = 0; r < Rr; r++) for (let c = 0; c < C; c++) {
        const i = idx(pi, c, r), a = a0 + (a1 - a0) * (c / (C - 1));
        uv[i * 2] = a / (Math.PI * 2); uv[i * 2 + 1] = 1 - r / (Rr - 1);
        uv1[i * 2] = a * 0.2; uv1[i * 2 + 1] = r * this.seg;
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
    g.setAttribute('aWear', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    const ix = [];
    for (let pi = 0; pi < P; pi++) for (let r = 0; r < Rr - 1; r++) for (let c = 0; c < C - 1; c++) {
      const a = idx(pi, c, r), b = idx(pi, c + 1, r), cc = idx(pi, c, r + 1), d = idx(pi, c + 1, r + 1);
      ix.push(a, cc, b, b, cc, d);
    }
    g.setIndex(ix);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);
    this.geo = g;
    let map = null;
    try { map = coatTexture(palette.coat, palette.coat2, palette.gold || palette.scarf2); } catch (_) { map = null; }
    this.map = map;
    const tex = getTextures(null);
    const hi = !lo;
    const mat = new (hi ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial)({
      map, color: map ? 0xffffff : palette.coat, roughness: 0.82, side: THREE.DoubleSide,
      normalMap: tex.fabricNormal || tex.woolNormal || null, normalScale: new THREE.Vector2(0.45, 0.45), alphaTest: map ? 0.5 : 0,
    });
    if (hi) { mat.sheen = 0.7; mat.sheenRoughness = 0.45; mat.sheenColor = new THREE.Color(palette.coat).lerp(new THREE.Color(0.62, 0.64, 0.8), 0.42); }
    patchLighting(mat, { rim: 0.32, sky: 0.34, key: 'coat', sunRim: 1.15, stars: 1, starUv: true });
    // darker lining on the inside faces
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      prev(sh, r);
      sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n  if (!gl_FrontFacing) diffuseColor.rgb *= 0.5;')
        // the lining is matte: no silk sheen on the inside faces (a flapping hem read as pale patches at the shins)
        .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n  #ifdef USE_SHEEN\n  if (!gl_FrontFacing) material.sheenColor *= 0.15;\n  #endif');
    };
    this.material = mat;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'explorer-coat';
    this.mesh.castShadow = true; this.mesh.receiveShadow = true; this.mesh.frustumCulled = false;
    this.group = new THREE.Group();
    this.group.name = 'coat';
    this.group.add(this.mesh);
  }

  /** Hips-space rest drape → planet-local, written into x (and p unless keepVel). */
  _target(i, hp, hq, gq, gp, out) {
    out.set(this.rest[i * 3], this.rest[i * 3 + 1], this.rest[i * 3 + 2]).applyQuaternion(hq).add(hp).applyQuaternion(gq).add(gp);
    return out;
  }

  reset(an, gq, gp) {
    const hp = an.gp[B.hips], hq = an.gq[B.hips];
    for (let i = 0; i < this.n; i++) {
      this._target(i, hp, hq, gq, gp, _v);
      this.x[i * 3] = this.p[i * 3] = _v.x; this.x[i * 3 + 1] = this.p[i * 3 + 1] = _v.y; this.x[i * 3 + 2] = this.p[i * 3 + 2] = _v.z;
    }
    this.initialized = true;
  }

  /**
   * @param an  Animator (gp / gq group-space bone transforms, after update)
   * @param gq, gp  character group transform (planet-local)
   * @param up  local up; g gravity; wind (m/s, planet-local); ground {p, n} plane under the body (optional)
   * @param opts { swim (0..1), rest (0..1) }
   */
  update(dt, an, gq, gp, up, g, wind, ground, opts) {
    if (!an) return;
    this.t += dt;
    if (!this.initialized) this.reset(an, gq, gp);
    const hp = an.gp[B.hips], hq = an.gq[B.hips];
    // collision capsules (group → planet-local)
    const cap = (k, b0, b1, r, o0 = 0, o1 = 0) => {
      const c = this.caps[k];
      c.a.copy(an.gp[b0]); c.b.copy(an.gp[b1]);
      if (o0) c.a.y += o0; if (o1) c.b.y += o1;
      c.a.applyQuaternion(gq).add(gp); c.b.applyQuaternion(gq).add(gp); c.r = r;
    };
    cap(0, B.thighL, B.thighR, 0.165);
    cap(1, B.thighL, B.shinL, 0.108); cap(2, B.thighR, B.shinR, 0.108);
    cap(3, B.shinL, B.footL, 0.078); cap(4, B.shinR, B.footR, 0.078);
    { // pack bottom (keeps the back panels off the lantern / pack)
      const c = this.caps[5];
      c.a.set(0.12, -0.24, -0.1).applyQuaternion(an.gq[B.pack]).add(an.gp[B.pack]).applyQuaternion(gq).add(gp);
      c.b.set(-0.12, -0.24, -0.1).applyQuaternion(an.gq[B.pack]).add(an.gp[B.pack]).applyQuaternion(gq).add(gp);
      c.r = 0.1;
    }
    const swim = opts?.swim || 0, rest = opts?.rest || 0;
    const steps = dt > 1 / 45 ? 3 : 2;
    const h = Math.min(dt, 1 / 20) / steps;
    const gg = g * (1 - 0.75 * swim);
    const gx = -up.x * gg, gy = -up.y * gg, gz = -up.z * gg;
    const X = this.x, Pp = this.p, N = this.nrm, C = this.cons, inv = this.inv;
    const Rr = this.rows, Cc = this.cols;
    const airK = 1 - 0.85 * swim;
    for (let st = 0; st < steps; st++) {
      // pins + integrate
      for (let i = 0; i < this.n; i++) {
        const o = i * 3;
        if (inv[i] === 0) {
          this._target(i, hp, hq, gq, gp, _v);
          X[o] = _v.x; X[o + 1] = _v.y; X[o + 2] = _v.z; Pp[o] = X[o]; Pp[o + 1] = X[o + 1]; Pp[o + 2] = X[o + 2];
          continue;
        }
        const vx = (X[o] - Pp[o]) / h, vy = (X[o + 1] - Pp[o + 1]) / h, vz = (X[o + 2] - Pp[o + 2]) / h;
        const r = ((i / Cc) | 0) % Rr, tr = r / (Rr - 1);
        const rx = wind.x - vx, ry = wind.y - vy, rz = wind.z - vz;
        const rl = Math.min(Math.sqrt(rx * rx + ry * ry + rz * rz), 30);
        const nx = N[o], ny = N[o + 1], nz = N[o + 2];
        const vn = rx * nx + ry * ny + rz * nz;
        // gusty flutter grows toward the hem; heavy wool → modest coefficients
        const fl = noise1(this.t * 1.7 + i * 0.37, 3) * (0.3 + 0.7 * tr) * Math.min(rl, 14) * 0.35;
        const kN = 0.55 * airK, kT = 0.06 * airK;
        const ax = gx + (vn * nx * kN + rx * kT) * rl * 0.3 + nx * fl;
        const ay = gy + (vn * ny * kN + ry * kT) * rl * 0.3 + ny * fl;
        const az = gz + (vn * nz * kN + rz * kT) * rl * 0.3 + nz * fl;
        const damp = swim > 0.5 ? 0.9 : 0.975;
        const nxp = X[o] + (X[o] - Pp[o]) * damp + ax * h * h;
        const nyp = X[o + 1] + (X[o + 1] - Pp[o + 1]) * damp + ay * h * h;
        const nzp = X[o + 2] + (X[o + 2] - Pp[o + 2]) * damp + az * h * h;
        Pp[o] = X[o]; Pp[o + 1] = X[o + 1]; Pp[o + 2] = X[o + 2];
        X[o] = nxp; X[o + 1] = nyp; X[o + 2] = nzp;
      }
      for (let it = 0; it < 4; it++) {
        // distance constraints
        for (let c = 0; c < C.length; c += 4) {
          const ia = C[c], ib = C[c + 1], a = ia * 3, b = ib * 3, rest0 = C[c + 2], stiff = C[c + 3];
          const dx = X[b] - X[a], dy = X[b + 1] - X[a + 1], dz = X[b + 2] - X[a + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const wa = inv[ia], wb = inv[ib], ws = wa + wb;
          if (ws === 0) continue;
          if (rest0 === 0) { // tie: pull together
            const k = stiff / ws;
            X[a] += dx * k * wa; X[a + 1] += dy * k * wa; X[a + 2] += dz * k * wa;
            X[b] -= dx * k * wb; X[b + 1] -= dy * k * wb; X[b + 2] -= dz * k * wb;
            continue;
          }
          if (d < 1e-9) continue;
          const diff = ((d - rest0) / d) * stiff / ws;
          X[a] += dx * diff * wa; X[a + 1] += dy * diff * wa; X[a + 2] += dz * diff * wa;
          X[b] -= dx * diff * wb; X[b + 1] -= dy * diff * wb; X[b + 2] -= dz * diff * wb;
        }
        // shape memory + leash + collisions
        for (let i = 0; i < this.n; i++) {
          if (inv[i] === 0) continue;
          const o = i * 3;
          const r = ((i / Cc) | 0) % Rr, tr = r / (Rr - 1);
          if (it === 0) {
            this._target(i, hp, hq, gq, gp, _v);
            const k = (0.06 * (1 - tr) + 0.012) * (1 - 0.6 * rest);
            X[o] += (_v.x - X[o]) * k; X[o + 1] += (_v.y - X[o + 1]) * k; X[o + 2] += (_v.z - X[o + 2]) * k;
            // leash: never further than ~(row length × 1.1) from where the drape would put it
            const dx = X[o] - _v.x, dy = X[o + 1] - _v.y, dz = X[o + 2] - _v.z;
            const lim = 0.08 + this.len * 1.26 * tr * 1.25;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > lim * lim) { const s = lim / Math.sqrt(d2); X[o] = _v.x + dx * s; X[o + 1] = _v.y + dy * s; X[o + 2] = _v.z + dz * s; }
          }
          for (let k = 0; k < this.caps.length; k++) {
            const cp = this.caps[k];
            const ax = cp.a.x, ay = cp.a.y, az = cp.a.z;
            const bx = cp.b.x - ax, by = cp.b.y - ay, bz = cp.b.z - az;
            const px = X[o] - ax, py = X[o + 1] - ay, pz = X[o + 2] - az;
            const bb = bx * bx + by * by + bz * bz;
            let t = bb > 1e-9 ? (px * bx + py * by + pz * bz) / bb : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const qx = px - bx * t, qy = py - by * t, qz = pz - bz * t;
            const d2 = qx * qx + qy * qy + qz * qz, rr = cp.r + 0.01;
            if (d2 < rr * rr) {
              const d = Math.sqrt(d2) || 1e-6, s = (rr - d) / d;
              X[o] += qx * s; X[o + 1] += qy * s; X[o + 2] += qz * s;
            }
          }
          if (ground?.on) {
            const gn = ground.n;
            const dd = (X[o] - ground.p.x) * gn.x + (X[o + 1] - ground.p.y) * gn.y + (X[o + 2] - ground.p.z) * gn.z - 0.012;
            if (dd < 0) {
              X[o] -= gn.x * dd; X[o + 1] -= gn.y * dd; X[o + 2] -= gn.z * dd;
              // friction: the hem settles instead of sliding about
              Pp[o] += (X[o] - Pp[o]) * 0.6; Pp[o + 1] += (X[o + 1] - Pp[o + 1]) * 0.6; Pp[o + 2] += (X[o + 2] - Pp[o + 2]) * 0.6;
            }
          }
        }
      }
    }
    // safety: NaN / teleport → reset
    for (let i = 0; i < this.n; i += 7) {
      const o = i * 3;
      if (!Number.isFinite(X[o] + X[o + 1] + X[o + 2])) { this.initialized = false; break; }
      const dx = X[o] - gp.x, dy = X[o + 1] - gp.y, dz = X[o + 2] - gp.z;
      if (dx * dx + dy * dy + dz * dz > 9) { this.initialized = false; break; }
    }
    if (!this.initialized) this.reset(an, gq, gp);
    // normals (grid per panel) + upload relative to the group origin
    const P = this.panels.length;
    for (let pi = 0; pi < P; pi++) for (let r = 0; r < Rr; r++) for (let c = 0; c < Cc; c++) {
      const i = this.idx(pi, c, r), o = i * 3;
      const iL = this.idx(pi, Math.max(0, c - 1), r) * 3, iR = this.idx(pi, Math.min(Cc - 1, c + 1), r) * 3;
      const iU = this.idx(pi, c, Math.max(0, r - 1)) * 3, iD = this.idx(pi, c, Math.min(Rr - 1, r + 1)) * 3;
      const tx = X[iR] - X[iL], ty = X[iR + 1] - X[iL + 1], tz = X[iR + 2] - X[iL + 2];
      const bx = X[iD] - X[iU], by = X[iD + 1] - X[iU + 1], bz = X[iD + 2] - X[iU + 2];
      // outward = tangent(around) × down
      let nx = ty * bz - tz * by, ny = tz * bx - tx * bz, nz = tx * by - ty * bx;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= l; ny /= l; nz /= l;
      N[o] = nx; N[o + 1] = ny; N[o + 2] = nz;
    }
    // orientation: make normals point away from the hips axis
    _w.copy(hp).applyQuaternion(gq).add(gp);
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      const ox = X[o] - _w.x, oy = X[o + 1] - _w.y, oz = X[o + 2] - _w.z;
      const sgn = ox * N[o] + oy * N[o + 1] + oz * N[o + 2] < 0 ? -1 : 1;
      this.rn[o] = N[o] * sgn; this.rn[o + 1] = N[o + 1] * sgn; this.rn[o + 2] = N[o + 2] * sgn;
      this.pos[o] = X[o] - gp.x; this.pos[o + 1] = X[o + 1] - gp.y; this.pos[o + 2] = X[o + 2] - gp.z;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    this.group.position.copy(gp);
    void _q;
  }

  dispose() {
    this.geo.dispose();
    this.material.dispose();
    this.map?.dispose();
  }
}
