// Flora textures, generated procedurally at startup (no files):
//   • leaf atlas (4×4 cells, Canvas 2D): leaf clusters, needles, fronds, ferns, blades, flowers…
//     Channels are *semantic* so every art-directed palette can recolor them:
//       R = shading/luminance detail   G = secondary-tint mask (twig, vein, flower center)
//       B = translucency (thin leaf=1)  A = coverage
//   • bark array texture (DataArrayTexture, tiling): R = albedo detail, G = height, B = moss mask
//   • rock detail texture (tiling): R = albedo detail, G = height, B = cavity/crack mask
import * as THREE from 'three';
import { mulberry, TAU } from './util.js';

export const ATLAS_CELLS = [
  'broad', 'broad2', 'small', 'needle',
  'pine', 'frond', 'fern', 'blades',
  'daisy', 'spike', 'cup', 'alienleaf',
  'vine', 'twigs', 'flowerball', 'spores',
];
const GRID = 4;

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
const rgb = (r, g, b) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;

// ------------------------------------------------------------------ leaf shapes (512-unit cell space)
function leafPath(ctx, L, W, tipSharp = 0.5, lobes = 0) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  if (lobes > 0) {
    // lobed (oak/maple-ish) outline
    const n = lobes;
    for (let k = 0; k <= n; k++) {
      const t = k / n, y = -L * t;
      const w = W * Math.sin(Math.PI * Math.min(1, t * 1.05)) * (k % 2 ? 0.62 : 1.0);
      ctx.lineTo(w, y);
    }
    for (let k = n; k >= 0; k--) {
      const t = k / n, y = -L * t;
      const w = W * Math.sin(Math.PI * Math.min(1, t * 1.05)) * (k % 2 ? 0.62 : 1.0);
      ctx.lineTo(-w, y);
    }
  } else {
    ctx.bezierCurveTo(W * 1.05, -L * 0.22, W * (0.9 - tipSharp * 0.4), -L * (0.78 + tipSharp * 0.08), 0, -L);
    ctx.bezierCurveTo(-W * (0.9 - tipSharp * 0.4), -L * (0.78 + tipSharp * 0.08), -W * 1.05, -L * 0.22, 0, 0);
  }
  ctx.closePath();
}

function drawLeaf(ctx, x, y, ang, L, W, lum, rnd, opts = {}) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  leafPath(ctx, L, W, opts.sharp ?? 0.5, opts.lobes ?? 0);
  // cross-leaf gradient gives a folded-leaf look; tip slightly lighter
  const g = ctx.createLinearGradient(-W, 0, W, 0);
  const side = rnd() < 0.5;
  const a = lum * (side ? 0.78 : 1.0), b = lum * (side ? 1.0 : 0.8);
  const tr = opts.trans ?? 1;
  g.addColorStop(0, rgb(a * 0.92, 0, tr));
  g.addColorStop(0.48, rgb(Math.min(1, (a + b) * 0.52), 0, tr));
  g.addColorStop(1, rgb(b, 0, tr));
  ctx.fillStyle = g;
  ctx.fill();
  // subtle rim darkening
  ctx.lineWidth = Math.max(1, W * 0.08);
  ctx.strokeStyle = rgb(lum * 0.62, 0, tr * 0.8);
  ctx.stroke();
  // midrib (vein → secondary tint slightly)
  if (L > 30 && opts.vein !== false) {
    ctx.beginPath();
    ctx.moveTo(0, -L * 0.02);
    ctx.quadraticCurveTo(W * 0.08, -L * 0.5, 0, -L * 0.92);
    ctx.lineWidth = Math.max(1, W * 0.09);
    ctx.strokeStyle = rgb(Math.min(1, lum * 1.12), 0.35, tr * 0.7);
    ctx.stroke();
    if (opts.veins) {
      ctx.lineWidth = Math.max(0.7, W * 0.04);
      for (let k = 1; k < 6; k++) {
        const t = k / 6.5;
        ctx.beginPath();
        ctx.moveTo(0, -L * t);
        ctx.quadraticCurveTo(W * 0.4, -L * (t + 0.06), W * 0.75, -L * (t + 0.16));
        ctx.moveTo(0, -L * t);
        ctx.quadraticCurveTo(-W * 0.4, -L * (t + 0.06), -W * 0.75, -L * (t + 0.16));
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

function twig(ctx, x0, y0, x1, y1, w, bend = 0) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  const mx = (x0 + x1) / 2 + (y1 - y0) * bend, my = (y0 + y1) / 2 - (x1 - x0) * bend;
  ctx.quadraticCurveTo(mx, my, x1, y1);
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.strokeStyle = rgb(0.42, 1, 0.15);
  ctx.stroke();
}


/** Paint a leaf cluster filling a soft disc (cell space 512). */
function leafCluster(ctx, rnd, o) {
  const cx = 256, cy = 256, R = o.R;
  const base = [256, 505];
  const tw = [];
  for (let k = 0; k < o.twigs; k++) {
    const a = -Math.PI / 2 + (k / (o.twigs - 1) - 0.5) * 2.3 + (rnd() - 0.5) * 0.25;
    const len = R * (0.75 + rnd() * 0.45);
    const x1 = cx + Math.cos(a) * len * 0.9, y1 = cy + 40 + Math.sin(a) * len * 0.85;
    twig(ctx, base[0] + (rnd() - 0.5) * 24, base[1], x1, y1, 3 + rnd() * 3, (rnd() - 0.5) * 0.25);
    tw.push([x1, y1]);
  }
  const leaves = [];
  for (let n = 0; n < o.n; n++) {
    const r = R * Math.pow(rnd(), 0.62), a = rnd() * TAU;
    let x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.94;
    if (o.droop) y += (r / R) * (r / R) * 40 * o.droop * 4;
    const edge = r / R;
    // leaves point away from the cluster base, with noise
    const dir = Math.atan2(y - base[1] + 120, x - base[0]) + Math.PI / 2 + (rnd() - 0.5) * 1.6;
    leaves.push({ x, y, dir, edge });
  }
  leaves.sort((p, q) => p.edge - q.edge);
  for (const lf of leaves) {
    const L = o.L[0] + rnd() * (o.L[1] - o.L[0]), W = o.W[0] + rnd() * (o.W[1] - o.W[0]);
    if (Math.hypot(lf.x - cx, lf.y - cy) + L * 0.9 > 250) continue;
    const lum = 0.38 + 0.42 * Math.pow(lf.edge, 0.7) + rnd() * 0.25;
    drawLeaf(ctx, lf.x, lf.y, lf.dir, L, W, Math.min(1, lum), rnd, o.lobes ? { lobes: 5 + ((rnd() * 3) | 0) * 2, veins: o.veins } : { sharp: o.sharp ?? 0.5, vein: o.vein });
  }
}

// ------------------------------------------------------------------ cell painters
const PAINT = {
  broad(ctx, rnd) {
    // dense rounded broadleaf cluster: twigs fan from the base, leaves fill a soft disc, inner
    // leaves darker (self-shadowing inside the cluster), outer leaves brighter
    leafCluster(ctx, rnd, { n: 300, R: 205, L: [36, 58], W: [15, 23], sharp: 0.55, twigs: 9 });
  },
  broad2(ctx, rnd) {
    // lobed leaves (oak/maple) — slightly larger, fuller
    leafCluster(ctx, rnd, { n: 200, R: 196, L: [46, 70], W: [24, 34], lobes: true, veins: true, twigs: 7 });
  },
  small(ctx, rnd) {
    // birch/aspen: many small rounded leaves on fine drooping twigs
    leafCluster(ctx, rnd, { n: 440, R: 215, L: [22, 34], W: [11, 16], sharp: 0.75, twigs: 12, droop: 0.25, vein: false });
  },
  needle(ctx, rnd) {
    // spruce/fir sprig: flat branch with dense short needles (seen from above)
    const main = [];
    for (let s = 0; s <= 20; s++) main.push([256 + Math.sin(s * 0.3) * 8, 500 - s * 24]);
    const needleRow = (x0, y0, x1, y1, len, count) => {
      for (let k = 0; k < count; k++) {
        const t = k / count, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
        const dir = Math.atan2(y1 - y0, x1 - x0);
        for (const sd of [-1, 1]) {
          const a = dir + sd * (0.9 + rnd() * 0.5);
          const l = len * (0.6 + 0.4 * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05))) * (0.8 + rnd() * 0.4);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
          const lum = 0.45 + rnd() * 0.55;
          ctx.strokeStyle = rgb(lum, 0, 0.55); ctx.lineWidth = 3.2; ctx.lineCap = 'round'; ctx.stroke();
        }
      }
    };
    for (let s = 2; s < 19; s += 2) {
      const [x, y] = main[s];
      for (const sd of [-1, 1]) {
        const len = (120 - s * 4) * (0.8 + rnd() * 0.3);
        const a = -Math.PI / 2 + sd * (0.95 + rnd() * 0.25);
        const x1 = x + Math.cos(a) * len, y1 = y + Math.sin(a) * len;
        twig(ctx, x, y, x1, y1, 3);
        needleRow(x, y, x1, y1, 22, 16);
      }
    }
    for (let s = 0; s < 20; s++) twig(ctx, main[s][0], main[s][1], main[s + 1][0], main[s + 1][1], 7 - s * 0.25);
    needleRow(256, 500, 256, 20, 26, 44);
  },
  pine(ctx, rnd) {
    // long-needle pine tufts / fir layer seen from the side (drooping)
    for (let k = 0; k < 6; k++) {
      const bx = 80 + k * 72 + (rnd() - 0.5) * 20, by = 470 - rnd() * 40;
      const ex = bx + (rnd() - 0.5) * 60, ey = 120 + rnd() * 80;
      twig(ctx, bx, by, ex, ey, 5);
      for (let t = 0.25; t <= 1.0; t += 0.035) {
        const x = bx + (ex - bx) * t, y = by + (ey - by) * t;
        const n = 5;
        for (let q = 0; q < n; q++) {
          const a = -Math.PI / 2 + (q - (n - 1) / 2) * 0.35 + (rnd() - 0.5) * 0.3;
          const l = 60 + rnd() * 40;
          ctx.beginPath(); ctx.moveTo(x, y);
          ctx.quadraticCurveTo(x + Math.cos(a) * l * 0.6, y + Math.sin(a) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l * 0.8 + 18);
          const lum = 0.45 + rnd() * 0.55;
          ctx.strokeStyle = rgb(lum, 0, 0.5); ctx.lineWidth = 2.6; ctx.stroke();
        }
      }
    }
  },
  frond(ctx, rnd) {
    // palm frond, vertical: rachis bottom → top, leaflets drooping outward
    const pts = [];
    for (let s = 0; s <= 30; s++) pts.push([256 + Math.sin(s * 0.08) * 10, 505 - s * 16.3]);
    for (let s = 2; s < 30; s++) {
      const [x, y] = pts[s];
      const t = s / 30;
      const len = 170 * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.08)) + 30;
      for (const sd of [-1, 1]) {
        const a = -Math.PI / 2 + sd * (1.05 + t * 0.35);
        ctx.save(); ctx.translate(x, y); ctx.rotate(a + Math.PI / 2);
        ctx.beginPath(); ctx.moveTo(-5, 0);
        ctx.quadraticCurveTo(-11, -len * 0.5, sd * 18, -len); ctx.quadraticCurveTo(9, -len * 0.5, 5, 0);
        ctx.closePath();
        const lum = 0.6 + rnd() * 0.4;
        const g = ctx.createLinearGradient(0, 0, 0, -len);
        g.addColorStop(0, rgb(lum * 0.8, 0.1, 0.9)); g.addColorStop(1, rgb(lum, 0, 1));
        ctx.fillStyle = g; ctx.fill();
        ctx.restore();
      }
    }
    for (let s = 0; s < 30; s++) twig(ctx, pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1], 8 - s * 0.2);
  },
  fern(ctx, rnd) {
    const pts = [];
    for (let s = 0; s <= 36; s++) pts.push([256 + Math.sin(s * 0.09) * 14, 505 - s * 13.6]);
    for (let s = 3; s < 36; s++) {
      const [x, y] = pts[s];
      const t = s / 36;
      const len = 150 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.95 + 0.05)), 0.8) * (1 - t * 0.3);
      for (const sd of [-1, 1]) {
        const a = -Math.PI / 2 + sd * (1.25 - t * 0.3);
        const ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
        twig(ctx, x, y, ex, ey, 2);
        const lob = Math.max(3, Math.round(len / 13));
        for (let k = 1; k <= lob; k++) {
          const u = k / (lob + 1);
          const lx = x + (ex - x) * u, ly = y + (ey - y) * u;
          for (const s2 of [-1, 1]) drawLeaf(ctx, lx, ly, a + Math.PI / 2 + s2 * 1.2, 16 * (1 - u * 0.6) + 6, 6.5, 0.6 + rnd() * 0.4, rnd, { vein: false, sharp: 0.2 });
        }
      }
    }
    for (let s = 0; s < 36; s++) twig(ctx, pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1], 5 - s * 0.1);
  },
  blades(ctx, rnd) {
    for (let k = 0; k < 16; k++) {
      const bx = 256 + (rnd() - 0.5) * 120, by = 512;
      const h = 300 + rnd() * 200, lean = (rnd() - 0.5) * 260, w = 9 + rnd() * 7;
      ctx.beginPath();
      ctx.moveTo(bx - w, by);
      ctx.quadraticCurveTo(bx - w * 0.6 + lean * 0.3, by - h * 0.55, bx + lean, by - h);
      ctx.quadraticCurveTo(bx + w * 0.6 + lean * 0.3, by - h * 0.55, bx + w, by);
      ctx.closePath();
      const lum = 0.5 + rnd() * 0.5;
      const g = ctx.createLinearGradient(0, by, 0, by - h);
      g.addColorStop(0, rgb(lum * 0.55, 0, 0.6)); g.addColorStop(0.6, rgb(lum, 0, 1)); g.addColorStop(1, rgb(Math.min(1, lum * 1.1), 0.3, 1));
      ctx.fillStyle = g; ctx.fill();
    }
  },
  daisy(ctx, rnd) {
    const n = 22;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU + (rnd() - 0.5) * 0.1;
      ctx.save(); ctx.translate(256, 256); ctx.rotate(a);
      ctx.beginPath(); ctx.ellipse(0, -130, 30, 110, 0, 0, TAU);
      const lum = 0.8 + rnd() * 0.2;
      const g = ctx.createLinearGradient(0, -20, 0, -240);
      g.addColorStop(0, rgb(lum * 0.7, 0, 1)); g.addColorStop(1, rgb(lum, 0, 1));
      ctx.fillStyle = g; ctx.fill();
      ctx.restore();
    }
    const g = ctx.createRadialGradient(240, 240, 10, 256, 256, 70);
    g.addColorStop(0, rgb(1, 1, 0.3)); g.addColorStop(1, rgb(0.6, 1, 0.3));
    ctx.beginPath(); ctx.arc(256, 256, 64, 0, TAU); ctx.fillStyle = g; ctx.fill();
    for (let k = 0; k < 60; k++) {
      const a = rnd() * TAU, r = Math.sqrt(rnd()) * 56;
      ctx.beginPath(); ctx.arc(256 + Math.cos(a) * r, 256 + Math.sin(a) * r, 4, 0, TAU);
      ctx.fillStyle = rgb(0.5 + rnd() * 0.3, 1, 0.3); ctx.fill();
    }
  },
  spike(ctx, rnd) {
    // lupine / foxglove spike: stem + many florets, bigger toward the base
    twig(ctx, 256, 512, 256 + (rnd() - 0.5) * 20, 40, 9);
    for (let k = 0; k < 90; k++) {
      const t = rnd();
      const y = 60 + t * 360, spread = 30 + t * 55;
      const x = 256 + (rnd() - 0.5) * 2 * spread;
      const r = 12 + t * 16 + rnd() * 6;
      ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.8, rnd() * 3, 0, TAU);
      const lum = 0.6 + rnd() * 0.4;
      ctx.fillStyle = rgb(lum, 0, 1); ctx.fill();
      ctx.beginPath(); ctx.arc(x - r * 0.2, y - r * 0.2, r * 0.35, 0, TAU);
      ctx.fillStyle = rgb(Math.min(1, lum * 1.2), 0.25, 1); ctx.fill();
    }
    for (let k = 0; k < 6; k++) drawLeaf(ctx, 256, 470 - k * 14, (k % 2 ? 1 : -1) * (0.9 + rnd() * 0.4), 90, 18, 0.6, rnd, { trans: 0.8 });
  },
  cup(ctx, rnd) {
    // tulip/poppy seen from the side
    twig(ctx, 256, 512, 250, 250, 10, 0.05);
    drawLeaf(ctx, 256, 500, -0.5, 190, 32, 0.65, rnd, { trans: 0.8 });
    drawLeaf(ctx, 256, 480, 0.6, 160, 28, 0.6, rnd, { trans: 0.8 });
    for (let k = 0; k < 5; k++) {
      const a = (k - 2) * 0.36;
      ctx.save(); ctx.translate(250, 262); ctx.rotate(a);
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.bezierCurveTo(-70, -30, -60, -170, 0, -200); ctx.bezierCurveTo(60, -170, 70, -30, 0, 0);
      const lum = k === 2 ? 1 : 0.78 + rnd() * 0.15;
      const g = ctx.createLinearGradient(0, 0, 0, -200);
      g.addColorStop(0, rgb(lum * 0.55, 0.6, 1)); g.addColorStop(0.35, rgb(lum * 0.9, 0, 1)); g.addColorStop(1, rgb(lum, 0, 1));
      ctx.fillStyle = g; ctx.fill();
      ctx.restore();
    }
  },
  alienleaf(ctx, rnd) {
    // big glossy alien leaf (NMS), bright veins in G
    ctx.save(); ctx.translate(256, 505);
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.bezierCurveTo(250, -60, 240, -420, 0, -495); ctx.bezierCurveTo(-240, -420, -250, -60, 0, 0);
    const g = ctx.createRadialGradient(0, -220, 30, 0, -250, 260);
    g.addColorStop(0, rgb(1, 0, 1)); g.addColorStop(1, rgb(0.55, 0.15, 0.9));
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = rgb(0.9, 1, 0.9);
    ctx.lineWidth = 9; ctx.beginPath(); ctx.moveTo(0, -5); ctx.quadraticCurveTo(12, -250, 0, -480); ctx.stroke();
    ctx.lineWidth = 4.5;
    for (let k = 1; k < 10; k++) {
      const t = k / 10.5;
      for (const sd of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(0, -470 * t);
        ctx.quadraticCurveTo(sd * 110, -470 * t - 40, sd * 200 * Math.sin(Math.PI * Math.min(1, t + 0.1)), -470 * t - 120 * (1 - t) - 40);
        ctx.stroke();
      }
    }
    // spots
    for (let k = 0; k < 40; k++) {
      const x = (rnd() - 0.5) * 300, y = -60 - rnd() * 380;
      if (Math.abs(x) > 200 * Math.sin(Math.PI * Math.min(1, (-y) / 480 + 0.08))) continue;
      ctx.beginPath(); ctx.arc(x, y, 5 + rnd() * 9, 0, TAU); ctx.fillStyle = rgb(1, 0.8, 1); ctx.fill();
    }
    ctx.restore();
  },
  vine(ctx, rnd) {
    for (let k = 0; k < 11; k++) {
      let x = 30 + k * 45 + (rnd() - 0.5) * 20, y = 0;
      const sway = (rnd() - 0.5) * 30, len = 300 + rnd() * 212;
      for (let s = 0; y < len; s++) {
        const nx = x + Math.sin(s * 0.5 + k) * 3 + sway * 0.04, ny = y + 18;
        twig(ctx, x, y, nx, ny, 2.2);
        if (rnd() < 0.8) drawLeaf(ctx, nx, ny, (rnd() < 0.5 ? -1 : 1) * (2.2 + rnd() * 0.6), 22 + rnd() * 12, 9 + rnd() * 4, 0.5 + rnd() * 0.5, rnd, { vein: false });
        x = nx; y = ny;
      }
    }
  },
  twigs(ctx, rnd) {
    const branch = (x, y, a, len, w, depth) => {
      const x1 = x + Math.cos(a) * len, y1 = y + Math.sin(a) * len;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x1, y1);
      ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.strokeStyle = rgb(0.35 + rnd() * 0.3, 1, 0.1); ctx.stroke();
      if (depth <= 0) return;
      const n = 2 + (rnd() < 0.4 ? 1 : 0);
      for (let k = 0; k < n; k++) branch(x1, y1, a + (rnd() - 0.5) * 1.3, len * (0.55 + rnd() * 0.2), w * 0.65, depth - 1);
    };
    for (let k = 0; k < 4; k++) branch(256 + (rnd() - 0.5) * 40, 512, -Math.PI / 2 + (k - 1.5) * 0.35, 130, 9, 5);
  },
  flowerball(ctx, rnd) {
    for (let k = 0; k < 170; k++) {
      const a = rnd() * TAU, r = Math.pow(rnd(), 0.55) * 225;
      const x = 256 + Math.cos(a) * r, y = 256 + Math.sin(a) * r;
      const s = 14 + rnd() * 10;
      const lum = 0.6 + 0.4 * (1 - r / 240) * rnd() + 0.2;
      for (let p = 0; p < 4; p++) {
        ctx.beginPath(); ctx.ellipse(x + Math.cos(p * 1.57 + a) * s * 0.5, y + Math.sin(p * 1.57 + a) * s * 0.5, s * 0.55, s * 0.4, p * 1.57 + a, 0, TAU);
        ctx.fillStyle = rgb(Math.min(1, lum), 0, 1); ctx.fill();
      }
      ctx.beginPath(); ctx.arc(x, y, s * 0.18, 0, TAU); ctx.fillStyle = rgb(1, 1, 1); ctx.fill();
    }
  },
  spores(ctx, rnd) {
    for (let k = 0; k < 70; k++) {
      const x = 40 + rnd() * 432, y = 40 + rnd() * 432, r = 6 + Math.pow(rnd(), 2) * 34;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgb(1, 1, 1)); g.addColorStop(0.5, rgb(0.9, 1, 1)); g.addColorStop(1, rgb(0.5, 0.6, 1));
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = g; ctx.fill();
    }
  },
};

/** Build the leaf/flower atlas. Returns { texture, rect(name) → [u0,v0,u1,v1] (v down) }. */
export function makeLeafAtlas(size = 2048, seed = 1) {
  const cv = makeCanvas(size, size);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, size, size);
  const cell = size / GRID;
  const rects = {};
  ATLAS_CELLS.forEach((name, k) => {
    const cx = (k % GRID) * cell, cy = Math.floor(k / GRID) * cell;
    ctx.save();
    ctx.beginPath(); ctx.rect(cx + 2, cy + 2, cell - 4, cell - 4); ctx.clip();
    ctx.translate(cx, cy);
    ctx.scale(cell / 512, cell / 512);
    try { PAINT[name](ctx, mulberry(seed * 31 + k * 7919)); } catch (e) { console.warn('[flora] atlas paint failed', name, e); }
    ctx.restore();
    const pad = 3 / size;
    rects[name] = [cx / size + pad, cy / size + pad, (cx + cell) / size - pad, (cy + cell) / size - pad];
  });
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  // Fill fully transparent texels with the cell's mean color so mips don't bleed black fringes.
  for (let k = 0; k < ATLAS_CELLS.length; k++) {
    const x0 = (k % GRID) * cell, y0 = Math.floor(k / GRID) * cell;
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let y = y0; y < y0 + cell; y += 2) for (let x = x0; x < x0 + cell; x += 2) {
      const i = (y * size + x) * 4;
      if (d[i + 3] > 200) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++; }
    }
    if (!n) continue;
    sr /= n; sg /= n; sb /= n;
    for (let y = y0; y < y0 + cell; y++) for (let x = x0; x < x0 + cell; x++) {
      const i = (y * size + x) * 4;
      if (d[i + 3] === 0) { d[i] = sr; d[i + 1] = sg; d[i + 2] = sb; }
    }
  }
  const tex = new THREE.DataTexture(new Uint8Array(d.buffer.slice(0)), size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.flipY = false;
  tex.needsUpdate = true;
  return { texture: tex, rects, rect: (name) => rects[name] || rects.broad };
}

// ------------------------------------------------------------------ tileable value noise
function makeTileNoise(seed) {
  const P = 256;
  const perm = new Uint8Array(P * 2);
  const vals = new Float32Array(P);
  const r = mulberry(seed);
  for (let i = 0; i < P; i++) { perm[i] = i; vals[i] = r(); }
  for (let i = P - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  for (let i = 0; i < P; i++) perm[P + i] = perm[i];
  const lat = (ix, iy, px, py) => vals[perm[(((ix % px) + px) % px) + perm[(((iy % py) + py) % py) & 255]] & 255];
  /** periodic value noise, periods px/py in lattice units */
  const noise = (x, y, px, py) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = lat(ix, iy, px, py), b = lat(ix + 1, iy, px, py), c = lat(ix, iy + 1, px, py), d = lat(ix + 1, iy + 1, px, py);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  const fbm = (u, v, fx, fy, oct) => {
    let s = 0, a = 0.5, n = 0;
    for (let o = 0; o < oct; o++) { s += a * noise(u * fx, v * fy, fx, fy); n += a; a *= 0.5; fx *= 2; fy *= 2; }
    return s / n;
  };
  // periodic cellular (worley F1) on a jittered grid
  const cells = (u, v, nx, ny) => {
    const x = u * nx, y = v * ny, ix = Math.floor(x), iy = Math.floor(y);
    let f1 = 9, f2 = 9, id = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox, cy = iy + oy;
      const wx = ((cx % nx) + nx) % nx, wy = ((cy % ny) + ny) % ny; // wrap → tileable
      const h = lat(wx * 7 + 3, wy * 13 + 5, 256, 256), h2 = lat(wx * 11 + 1, wy * 5 + 9, 256, 256);
      const dx = cx + h - x, dy = cy + h2 - y, dd = dx * dx + dy * dy;
      if (dd < f1) { f2 = f1; f1 = dd; id = lat(wx + 17, wy + 29, 256, 256); } else if (dd < f2) f2 = dd;
    }
    return [Math.sqrt(f1), Math.sqrt(f2), id];
  };
  return { noise, fbm, cells };
}

export const BARK = { furrow: 0, birch: 1, palm: 2, smooth: 3, plates: 4, organic: 5 };

/** Tiling bark layers (u around the trunk, v along it). */
export function makeBarkTexture(w = 256, h = 512, seed = 7) {
  const layers = 6;
  const data = new Uint8Array(w * h * 4 * layers);
  const N = makeTileNoise(seed);
  for (let L = 0; L < layers; L++) {
    const base = L * w * h * 4;
    for (let y = 0; y < h; y++) {
      const v = y / h;
      for (let x = 0; x < w; x++) {
        const u = x / w;
        let alb = 0.5, ht = 0.5, moss = 0;
        if (L === 0) { // deep vertical furrows that split and merge (oak/ash), fibrous ridges
          const warp = N.fbm(u, v, 4, 2, 3) * 0.3 + N.fbm(u, v, 8, 3, 2) * 0.08;
          const ridge = 1 - Math.abs(N.fbm(u + warp, v, 10, 2, 4) * 2 - 1);
          const plate = N.cells(u + warp * 0.6, v, 12, 3);
          const pe = Math.min(1, (plate[1] - plate[0]) * 2.2);
          const fib = N.noise(u * 128, v * 12, 128, 12) * 0.6 + N.noise(u * 64, v * 24, 64, 24) * 0.4;
          ht = Math.pow(ridge, 1.3) * 0.55 + pe * 0.3 + fib * 0.15;
          alb = 0.3 + ht * 0.55 + (fib - 0.5) * 0.16 + (plate[2] - 0.5) * 0.08;
          moss = Math.max(0, 1 - ht * 1.8) * N.fbm(u, v, 3, 3, 3);
        } else if (L === 1) { // birch: white, horizontal dark lenticels + black patches
          const len = N.noise(u * 8, v * 64, 8, 64);
          const lent = len > 0.72 ? (len - 0.72) * 3.5 : 0;
          const patch = N.fbm(u, v, 3, 6, 4);
          const dark = Math.max(lent, patch > 0.64 ? (patch - 0.64) * 4 : 0);
          alb = Math.max(0.08, 0.92 - dark * 0.85 - (N.noise(u * 32, v * 32, 32, 32) - 0.5) * 0.08);
          ht = 0.6 - dark * 0.4;
        } else if (L === 2) { // palm: horizontal rings with fibrous texture
          const ring = 0.5 + 0.5 * Math.cos(v * TAU * 16 + N.fbm(u, v, 4, 4, 2) * 2.5);
          const fib = N.noise(u * 96, v * 12, 96, 12);
          ht = Math.pow(ring, 3) * 0.7 + fib * 0.3;
          alb = 0.38 + ht * 0.45;
        } else if (L === 3) { // smooth/fungal: fine vertical fibers + pores
          const fib = N.fbm(u, v, 24, 3, 3);
          const pore = N.cells(u, v, 16, 24)[0];
          ht = fib * 0.7 + Math.min(1, pore * 1.4) * 0.3;
          alb = 0.55 + (fib - 0.5) * 0.3 + (pore < 0.12 ? -0.2 : 0);
        } else if (L === 4) { // conifer bark: long vertical plates split by deep dark furrows, flaky
          const warp = N.fbm(u, v, 3, 2, 3) * 0.28;
          const c = N.cells(u + warp, v + warp * 0.3, 9, 4);
          const edge = Math.min(1, (c[1] - c[0]) * 2.6);
          const furrow = Math.pow(edge, 0.55);
          const fib = N.noise(u * 128, v * 16, 128, 16) * 0.55 + N.noise(u * 32, v * 64, 32, 64) * 0.45;
          const flake = N.cells(u, v, 32, 24);
          const fl = Math.min(1, (flake[1] - flake[0]) * 3);
          ht = furrow * (0.6 + c[2] * 0.25) + fib * 0.12 + fl * 0.1 * furrow;
          alb = 0.18 + furrow * (0.45 + c[2] * 0.2) + (fib - 0.5) * 0.14 + (flake[2] - 0.5) * 0.08 * furrow;
          moss = Math.max(0, 0.45 - furrow) * N.fbm(u, v, 2, 2, 2) * 1.5;
        } else { // organic alien scales
          const c = N.cells(u, v, 8, 14);
          const edge = Math.min(1, (c[1] - c[0]) * 5);
          ht = Math.sqrt(edge) * (0.8 - c[0] * 0.3);
          alb = 0.4 + ht * 0.4 + (c[2] - 0.5) * 0.25;
        }
        const i = base + (y * w + x) * 4;
        data[i] = Math.max(0, Math.min(255, alb * 255));
        data[i + 1] = Math.max(0, Math.min(255, ht * 255));
        data[i + 2] = Math.max(0, Math.min(255, moss * 255));
        data[i + 3] = 255;
      }
    }
  }
  const tex = new THREE.DataArrayTexture(data, w, h, layers);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Tiling rock detail: R albedo detail, G height, B cavity. */
export function makeRockTexture(size = 512, seed = 11) {
  const data = new Uint8Array(size * size * 4);
  const N = makeTileNoise(seed);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const base = N.fbm(u, v, 4, 4, 6);
      // warped, broken cracks (not a regular cell net → no tortoise-shell/cobblestone look)
      const wu = u + (N.fbm(u, v, 3, 3, 3) - 0.5) * 0.18, wv = v + (N.fbm(u + 0.37, v, 3, 3, 3) - 0.5) * 0.18;
      const c = N.cells(wu, wv, 5, 5);
      const brk = N.fbm(u, v, 6, 6, 3);
      const crack = Math.max(0, 1 - (c[1] - c[0]) * 11) * (brk > 0.5 ? Math.min(1, (brk - 0.5) * 5) : 0);
      const grain = N.noise(u * 128, v * 128, 128, 128);
      const ht = base * 0.75 + grain * 0.12 - crack * 0.35 + 0.15;
      const alb = 0.45 + (base - 0.5) * 0.7 + (grain - 0.5) * 0.18 - crack * 0.25 + (c[2] - 0.5) * 0.12;
      const i = (y * size + x) * 4;
      data[i] = Math.max(0, Math.min(255, alb * 255));
      data[i + 1] = Math.max(0, Math.min(255, ht * 255));
      data[i + 2] = Math.max(0, Math.min(255, crack * 255));
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
