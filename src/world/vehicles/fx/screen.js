// Diegetic cockpit screens: a small canvas redrawn at a few Hz (speed, throttle, attitude, altitude,
// compass, target) shown as an HDR emissive panel on the dashboard. One texture per vehicle; the
// canvas upload is ~160 KB and only happens while the vehicle is occupied and near the camera.
import * as THREE from 'three';

const W = 512, H = 160;

export class CockpitScreen {
  constructor({ tint = [0.35, 0.9, 1.0], width = 0.8, height = 0.25, kind = 'ship' } = {}) {
    this.kind = kind;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.generateMipmaps = false;
    this.tex.minFilter = THREE.LinearFilter;
    this.tint = tint;
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false, color: new THREE.Color(1.5, 1.5, 1.5), fog: true });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), this.mat);
    this.mesh.name = 'cockpit-screen';
    this.t = 0;
    this.drawn = false;
    this.draw({});
  }

  /** Redraw at ~5 Hz when `active`. data: { speed, throttle, alt, bank, pitch, heading, target, status, gear } */
  update(dt, active, data) {
    this.t -= dt;
    if (!active) { if (this.drawn) return; }
    if (this.t > 0 && this.drawn) return;
    this.t = 0.2;
    this.draw(data);
  }

  draw(d) {
    const g = this.ctx, [tr, tg, tb] = this.tint;
    const col = (a) => `rgba(${Math.round(tr * 255)},${Math.round(tg * 255)},${Math.round(tb * 255)},${a})`;
    const warm = (a) => `rgba(255,${Math.round(150 + tg * 40)},70,${a})`;
    g.fillStyle = '#05080a'; g.fillRect(0, 0, W, H);
    // scanline texture + vignette
    g.fillStyle = 'rgba(255,255,255,0.025)';
    for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
    g.lineWidth = 2;
    const panel = (x, w) => { g.strokeStyle = col(0.35); g.strokeRect(x + 4, 6, w - 8, H - 12); };
    panel(0, 170); panel(170, 172); panel(342, 170);
    g.font = '600 13px "DejaVu Sans Mono", monospace';
    g.textBaseline = 'middle';
    // --- left: speed + throttle arc
    const sp = d.speed ?? 0;
    g.fillStyle = col(0.9);
    g.font = '700 38px "DejaVu Sans Condensed", "DejaVu Sans", sans-serif';
    g.textAlign = 'center';
    const spTxt = sp >= 10000 ? `${(sp / 1000).toFixed(0)}k` : `${Math.round(sp * 3.6)}`;
    g.fillText(spTxt, 85, 78);
    g.font = '600 12px "DejaVu Sans Mono", monospace';
    g.fillStyle = col(0.6);
    g.fillText(sp >= 10000 ? 'KM/S' : 'KM/H', 85, 110);
    const thr = Math.max(0, Math.min(1, d.throttle ?? 0));
    g.lineWidth = 7; g.strokeStyle = col(0.15);
    g.beginPath(); g.arc(85, 82, 58, Math.PI * 0.8, Math.PI * 2.2); g.stroke();
    g.strokeStyle = d.boost > 0.3 ? warm(0.95) : col(0.85);
    g.beginPath(); g.arc(85, 82, 58, Math.PI * 0.8, Math.PI * (0.8 + 1.4 * thr)); g.stroke();
    if (d.status) { g.fillStyle = warm(0.95); g.fillText(d.status, 85, 138); }
    // --- middle: attitude indicator (ship) / compass + tilt (rover)
    g.save();
    g.beginPath(); g.rect(176, 10, 160, H - 20); g.clip();
    g.translate(256, 80);
    g.rotate(-(d.bank ?? 0));
    const pp = (d.pitch ?? 0) * 110;
    g.fillStyle = col(0.12); g.fillRect(-160, pp, 320, 160);
    g.strokeStyle = col(0.9); g.lineWidth = 2;
    g.beginPath(); g.moveTo(-160, pp); g.lineTo(160, pp); g.stroke();
    g.lineWidth = 1; g.strokeStyle = col(0.5);
    for (let k = -3; k <= 3; k++) { if (!k) continue; const y = pp - k * 22; const w = k % 2 ? 18 : 34; g.beginPath(); g.moveTo(-w, y); g.lineTo(w, y); g.stroke(); }
    g.restore();
    g.strokeStyle = warm(0.95); g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(222, 80); g.lineTo(246, 80); g.lineTo(256, 90); g.lineTo(266, 80); g.lineTo(290, 80); g.stroke();
    // heading tape
    const hd = ((d.heading ?? 0) * 180 / Math.PI + 360) % 360;
    g.fillStyle = col(0.8); g.font = '600 11px "DejaVu Sans Mono", monospace';
    for (let k = -3; k <= 3; k++) {
      const deg = Math.round(hd / 15) * 15 + k * 15;
      const x = 256 + (deg - hd) * 3.2;
      if (x < 184 || x > 328) continue;
      const lab = ((deg % 360) + 360) % 360;
      g.fillRect(x - 0.5, 18, 1, lab % 45 === 0 ? 9 : 5);
      if (lab % 45 === 0) g.fillText(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][lab / 45], x, 34);
    }
    // --- right: altitude / grip / target
    g.textAlign = 'left';
    g.fillStyle = col(0.6); g.font = '600 12px "DejaVu Sans Mono", monospace';
    g.fillText(this.kind === 'ship' ? 'ALT' : 'GRIP', 356, 30);
    g.fillStyle = col(0.95); g.font = '700 26px "DejaVu Sans Condensed", "DejaVu Sans", sans-serif';
    if (this.kind === 'ship') {
      const a = d.alt ?? 0;
      g.fillText(a < 10000 ? `${Math.round(a)} m` : `${(a / 1000).toFixed(1)} km`, 356, 58);
    } else g.fillText(String(d.surface ?? 'ground').toUpperCase(), 356, 58);
    g.fillStyle = col(0.6); g.font = '600 12px "DejaVu Sans Mono", monospace';
    if (d.target) { g.fillText('NAV', 356, 88); g.fillStyle = col(0.9); g.fillText(String(d.target).slice(0, 18), 356, 106); }
    if (d.gear !== undefined) { g.fillStyle = d.gear > 0.5 ? warm(0.9) : col(0.4); g.fillText(d.gear > 0.5 ? 'GEAR DOWN' : 'GEAR UP', 356, 134); }
    // bars
    g.fillStyle = col(0.35);
    for (let k = 0; k < 10; k++) g.fillRect(470, 130 - k * 11, 24, 7);
    g.fillStyle = col(0.9);
    const e = Math.round(Math.max(0, Math.min(1, d.engine ?? 0)) * 10);
    for (let k = 0; k < e; k++) g.fillRect(470, 130 - k * 11, 24, 7);
    this.tex.needsUpdate = true;
    this.drawn = true;
  }

  dispose() { this.tex.dispose(); this.mat.dispose(); this.mesh.geometry.dispose(); }
}
