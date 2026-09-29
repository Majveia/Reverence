// Player track — procedural textures (canvas → height → normal maps), generated once and cached.
//   panelNormal : 512² atlas, 4 hard-surface panel layouts (inset grooves, vents, rivets, emboss)
//                 mapped per plate with uv (0..1) → quadrant.
//   fabricNormal: 256² tileable technical fabric (fine weave + quilted stitch channels), uv1 (meters).
//   wearRough   : 256² tileable roughness variation (smudges, micro scratches), uv1 (meters).
import * as THREE from 'three';
import { FastRand } from './util.js';

let _cache = null;

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d', { willReadFrequently: true }); // generated on the CPU and read back (height → normal)
  return c;
}

/** Height (grayscale canvas) → tangent-space normal map (RGBA8). */
function heightToNormal(src, strength, wrap) {
  const w = src.width, h = src.height;
  const sd = src.getContext('2d').getImageData(0, 0, w, h).data;
  const H = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) H[i] = sd[i * 4] / 255;
  const out = canvas(w, h);
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const at = (x, y) => {
    if (wrap) { x = (x + w) % w; y = (y + h) % h; } else { x = x < 0 ? 0 : x >= w ? w - 1 : x; y = y < 0 ? 0 : y >= h ? h - 1 : y; }
    return H[y * w + x];
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // Sobel
    const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
    const l = at(x - 1, y), r = at(x + 1, y);
    const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
    const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
    const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
    let nx = -dx * strength, ny = dy * strength, nz = 1;
    const len = Math.hypot(nx, ny, nz);
    nx /= len; ny /= len; nz /= len;
    const i = (y * w + x) * 4;
    d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function panelAtlas() {
  const S = 512, Q = S / 2;
  const c = canvas(S, S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgb(128,128,128)';
  ctx.fillRect(0, 0, S, S);
  const rnd = new FastRand(7);
  // orange-peel micro noise
  for (let i = 0; i < 9000; i++) {
    const v = 118 + rnd.next() * 20 | 0;
    ctx.fillStyle = `rgba(${v},${v},${v},0.35)`;
    ctx.fillRect(rnd.next() * S, rnd.next() * S, 2, 2);
  }
  ctx.filter = 'blur(0.8px)';
  ctx.drawImage(c, 0, 0);
  ctx.filter = 'none';
  const groove = (x, y, w, h, r, lw = 5) => {
    roundRect(ctx, x, y, w, h, r);
    ctx.lineWidth = lw; ctx.strokeStyle = 'rgb(40,40,40)'; ctx.stroke();
    roundRect(ctx, x + 1.5, y + 1.5, w - 3, h - 3, r);
    ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(180,180,180,0.7)'; ctx.stroke();
  };
  const rivet = (x, y, r = 4.5) => {
    const g = ctx.createRadialGradient(x - 1, y - 1, 0.5, x, y, r);
    g.addColorStop(0, 'rgb(215,215,215)'); g.addColorStop(0.7, 'rgb(160,160,160)'); g.addColorStop(1, 'rgba(60,60,60,1)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  };
  // Q0: clean plate with inset groove + corner rivets
  groove(Q * 0.07, Q * 0.07, Q * 0.86, Q * 0.86, 22);
  for (const [px, py] of [[0.16, 0.16], [0.84, 0.16], [0.16, 0.84], [0.84, 0.84]]) rivet(Q * px, Q * py);
  // Q1: split plate: groove + center seam + raised emboss
  ctx.save(); ctx.translate(Q, 0);
  groove(Q * 0.07, Q * 0.07, Q * 0.86, Q * 0.86, 18);
  ctx.beginPath(); ctx.moveTo(Q * 0.5, Q * 0.1); ctx.lineTo(Q * 0.5, Q * 0.9); ctx.lineWidth = 4; ctx.strokeStyle = 'rgb(55,55,55)'; ctx.stroke();
  roundRect(ctx, Q * 0.18, Q * 0.3, Q * 0.24, Q * 0.4, 10); ctx.fillStyle = 'rgb(165,165,165)'; ctx.fill();
  roundRect(ctx, Q * 0.58, Q * 0.3, Q * 0.24, Q * 0.4, 10); ctx.fill();
  ctx.restore();
  // Q2: vents
  ctx.save(); ctx.translate(0, Q);
  groove(Q * 0.07, Q * 0.07, Q * 0.86, Q * 0.86, 20);
  for (let i = 0; i < 6; i++) {
    roundRect(ctx, Q * 0.25, Q * (0.28 + i * 0.08), Q * 0.5, Q * 0.035, 4);
    ctx.fillStyle = 'rgb(45,45,45)'; ctx.fill();
  }
  rivet(Q * 0.15, Q * 0.5, 4); rivet(Q * 0.85, Q * 0.5, 4);
  ctx.restore();
  // Q3: layered armor: double groove + chevron
  ctx.save(); ctx.translate(Q, Q);
  groove(Q * 0.07, Q * 0.07, Q * 0.86, Q * 0.86, 26);
  groove(Q * 0.2, Q * 0.2, Q * 0.6, Q * 0.6, 16, 3.5);
  ctx.beginPath(); ctx.moveTo(Q * 0.3, Q * 0.62); ctx.lineTo(Q * 0.5, Q * 0.44); ctx.lineTo(Q * 0.7, Q * 0.62);
  ctx.lineWidth = 5; ctx.strokeStyle = 'rgb(170,170,170)'; ctx.stroke();
  ctx.restore();
  // micro scratches everywhere
  for (let i = 0; i < 70; i++) {
    const x = rnd.next() * S, y = rnd.next() * S, a = rnd.next() * Math.PI, l = 6 + rnd.next() * 26;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.lineWidth = 0.8; ctx.strokeStyle = 'rgba(95,95,95,0.55)'; ctx.stroke();
  }
  ctx.filter = 'blur(0.6px)';
  ctx.drawImage(c, 0, 0);
  ctx.filter = 'none';
  return { normal: heightToNormal(c, 2.2, false), albedo: panelAlbedo(c, rnd) };
}

/**
 * Albedo multiplier for the plates from the panel height: dark panel lines / vent slots (they read at
 * game distance where the normal detail does not), grime settling under ridges, rain/dust streaks running
 * down each plate, a few light scuffs. Linear values around 1.0 (multiplied with the vertex colour).
 */
function panelAlbedo(hsrc, rnd) {
  const S = hsrc.width;
  const hd = hsrc.getContext('2d').getImageData(0, 0, S, S).data;
  const out = canvas(S, S);
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(S, S);
  const d = img.data;
  // vertical streak field (per column), stronger toward the bottom of each quadrant
  const streak = new Float32Array(S);
  for (let x = 0; x < S; x++) streak[x] = 0;
  for (let k = 0; k < 90; k++) {
    const x0 = rnd.next() * S | 0, w = 1 + rnd.next() * 5, a = 0.04 + rnd.next() * 0.09;
    for (let x = Math.max(0, x0 - w | 0); x < Math.min(S, x0 + w); x++) streak[x] += a * (1 - Math.abs(x - x0) / w);
  }
  const Q = S / 2;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const h = hd[i] / 255;
    const hu = hd[Math.max(0, y - 3) * S * 4 + x * 4] / 255; // height a little above (grime pools under ridges)
    let a = 1;
    if (h < 0.42) a *= 0.42 + 0.58 * Math.max(0, (h - 0.12) / 0.3); // grooves, vents
    if (hu > h + 0.12) a *= 0.86;
    const qy = (y % Q) / Q; // 0 top → 1 bottom of the plate (atlas v is flipped by the texture upload)
    a *= 1 - streak[x] * (0.25 + 0.75 * qy);
    if (h > 0.62) a *= 1.04; // raised emboss catches less dirt
    const v = Math.max(0, Math.min(255, a * 248)) | 0;
    d[i] = v; d[i + 1] = v; d[i + 2] = Math.min(255, v + 2); d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function fabric() {
  const S = 256;
  const c = canvas(S, S);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const d = img.data;
  // twill weave: diagonal ribs + fine thread noise (tileable by construction)
  const rnd = new FastRand(3);
  const jitter = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) jitter[i] = rnd.next();
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const tw = 0.5 + 0.5 * Math.sin(((x + y) / S) * Math.PI * 2 * 48);
    const warp = 0.5 + 0.5 * Math.sin((x / S) * Math.PI * 2 * 96);
    const weft = 0.5 + 0.5 * Math.sin((y / S) * Math.PI * 2 * 96);
    let v = 0.5 + 0.22 * (tw - 0.5) + 0.12 * ((warp * weft) - 0.25) + 0.06 * (jitter[y * S + x] - 0.5);
    // quilted stitch channels every 1/4 tile (horizontal) — puffed between seams
    const q = (y / S) * 4, fq = q - Math.floor(q);
    const puff = Math.sin(fq * Math.PI);
    v = v * 0.55 + 0.45 * (0.25 + 0.75 * Math.pow(puff, 0.6));
    // stitches along the seams
    const seam = Math.min(fq, 1 - fq);
    if (seam < 0.035 && ((x >> 2) & 1) === 0) v -= 0.12;
    const b = Math.max(0, Math.min(255, v * 255)) | 0;
    const i = (y * S + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = b; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return heightToNormal(c, 1.6, true);
}

function wear() {
  const S = 256;
  const c = canvas(S, S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgb(128,128,128)';
  ctx.fillRect(0, 0, S, S);
  const rnd = new FastRand(11);
  // smudges (tile-wrapped)
  for (let i = 0; i < 90; i++) {
    const x = rnd.next() * S, y = rnd.next() * S, r = 6 + rnd.next() * 34, v = rnd.next() < 0.5 ? 90 : 175;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      g.addColorStop(0, `rgba(${v},${v},${v},0.22)`); g.addColorStop(1, `rgba(${v},${v},${v},0)`);
      ctx.fillStyle = g; ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }
  // micro scratches (shinier)
  for (let i = 0; i < 160; i++) {
    const x = rnd.next() * S, y = rnd.next() * S, a = rnd.next() * Math.PI, l = 3 + rnd.next() * 14;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.lineWidth = 0.7; ctx.strokeStyle = 'rgba(60,60,60,0.5)'; ctx.stroke();
  }
  return c;
}

/** All textures (created once per page; shared across worlds). */
export function getTextures(renderer) {
  if (_cache) return _cache;
  const aniso = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() ?? 1);
  const mk = (cv, { srgb = false, repeat = false, channel = 0 } = {}) => {
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.anisotropy = aniso;
    t.channel = channel;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.needsUpdate = true;
    return t;
  };
  let panel, panelA, fab, wr;
  try {
    const pa = panelAtlas();
    panel = mk(pa.normal, { channel: 0 });
    panelA = mk(pa.albedo, { channel: 0, srgb: true });
  } catch (e) { panel = null; panelA = null; }
  try { fab = mk(fabric(), { repeat: true, channel: 1 }); } catch (e) { fab = null; }
  try { wr = mk(wear(), { repeat: true, channel: 1 }); } catch (e) { wr = null; }
  _cache = { panelNormal: panel, panelAlbedo: panelA, fabricNormal: fab, wearRough: wr };
  return _cache;
}
