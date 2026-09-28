// Audio debug overlay (AUDIO track) — enabled with ?audiodebug=1.
// Minimal OLED panel: style / key / tempo / section / chord trail / arrangement layers / ambience beds and a
// log-frequency spectrogram. When the AudioContext is live it scrolls the real master output; while audio is
// still locked (e.g. deterministic captures) it renders a 10 s preview of the CURRENT world through an
// OfflineAudioContext (same graph, same seed) and paints that instead.
const MAGMA = [[0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]];
function cmap(v) { v = Math.max(0, Math.min(1, v)) * (MAGMA.length - 1); const i = Math.floor(v), f = v - i; const a = MAGMA[i], b = MAGMA[Math.min(MAGMA.length - 1, i + 1)]; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; }

function fft(re, im) { // in-place radix-2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j], ai = im[i + j], br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br; im[i + j] = ai + bi; re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

const CSS = `
#rv-audio-debug{position:fixed;left:16px;bottom:16px;z-index:9999;width:min(430px,calc(100vw - 32px));box-sizing:border-box;padding:10px 12px 10px;
 background:rgba(2,3,6,.78);border:1px solid rgba(255,255,255,.08);border-radius:12px;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
 color:#cdd5e3;font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;pointer-events:none;letter-spacing:.01em}
#rv-audio-debug .h{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:4px}
#rv-audio-debug .t{font:600 11px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;color:#fff;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
#rv-audio-debug .s{color:#8f9bb3;font-size:9px;white-space:nowrap}
#rv-audio-debug .n{color:#a8b3c8;margin-bottom:6px;font-style:italic;font-family:system-ui,sans-serif}
#rv-audio-debug .g{display:grid;grid-template-columns:58px 1fr;gap:0 8px}
#rv-audio-debug .k{color:#6f7a90;text-transform:uppercase;font-size:9.5px;padding-top:1px}
#rv-audio-debug .chips span{display:inline-block;margin:0 3px 2px 0;padding:0 5px;border-radius:9px;border:1px solid rgba(255,255,255,.12);color:#6f7a90}
#rv-audio-debug .chips span.on{color:#0b0d12;background:#ffd08a;border-color:#ffd08a}
#rv-audio-debug .chips span.amb{color:#0b0d12;background:#8fe3d0;border-color:#8fe3d0}
#rv-audio-debug canvas{display:block;width:100%;margin-top:8px;border-radius:6px;background:#000}
#rv-audio-debug .ax{display:flex;justify-content:space-between;color:#56607a;font-size:9px;margin-top:2px}
`;

export class AudioOverlay {
  constructor(host) {
    this.host = host; this.t = 0;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const el = this.el = document.createElement('div'); el.id = 'rv-audio-debug';
    el.innerHTML = '<div class="h"><div class="t">♪ Audio</div><div class="s"></div></div><div class="n"></div><div class="g"></div><canvas width="860" height="260"></canvas><div class="ax"><span></span><span></span></div>';
    document.body.appendChild(el);
    this.cv = el.querySelector('canvas'); this.g2 = this.cv.getContext('2d');
    this.g2.fillStyle = '#000'; this.g2.fillRect(0, 0, this.cv.width, this.cv.height);
    this.info = null;
    if (!host.ctx) { // wait for the world to be ready (and a moment of sim) so the preview hears the real scene
      this.el.querySelector('.s').textContent = 'waiting for world…';
      const iv = setInterval(() => {
        if (host.ctx) { clearInterval(iv); return; }
        const e = host.engine;
        if ((e?.isReady || window.__rv?.ready) && (e?.time?.t ?? 0) > 0.4) { clearInterval(iv); this._preview(); }
      }, 250);
    } else this._live = true;
  }

  async _preview() {
    const h = this.host;
    this.el.querySelector('.s').textContent = 'rendering offline preview…';
    try {
      for (let i = 0; i < 3; i++) { h._worldT = 0; h._sense(0.4); }
      const P = h.P, body = h._body();
      const mode = h.engine?.director?.currentName;
      const scene = mode === 'cosmic' || mode === 'galaxy' ? mode : P.space > 0.85 ? 'space' : 'surface';
      const over = {}; for (const k of ['night', 'wind', 'rain', 'snow', 'storm', 'shore', 'city', 'cityStyle', 'flora', 'fauna', 'hot', 'cold', 'wet', 'space', 'dawn', 'altitude', 'underwater']) over[k] = P[k];
      if (scene !== 'surface') { delete over.space; }
      const res = await h.constructor.renderOffline({ seconds: 15, sampleRate: 22050, scene, art: body?.art?.key, seed: body?.seed ?? 1234, type: body?.type, over, params: { ...h.params, cosmicGrowth: h.params.cosmicGrowth || (scene === 'cosmic' ? 0.6 : 0) }, quality: 'med', walk: 0 });
      this.info = res.debug; this._paintOffline(res);
      this.el.querySelector('.s').textContent = 'offline render · deterministic';
      this._text(res.debug);
    } catch (e) { this.el.querySelector('.s').textContent = 'preview failed: ' + e.message; }
  }

  _rows() { return this.cv.height; }
  _paintOffline(res) {
    const L = res.channels[0], R = res.channels[1], sr = res.sampleRate;
    const N = 2048, cols = this.cv.width, H = this.cv.height;
    const skip = Math.floor(sr * 4); // paint 4–15 s: past the intro bars
    const hop = Math.max(1, Math.floor((L.length - skip - N) / cols));
    const img = this.g2.createImageData(cols, H);
    const re = new Float32Array(N), im = new Float32Array(N), win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    const fLo = 35, fHi = sr / 2, lr = Math.log(fHi / fLo);
    const binOf = new Int32Array(H); for (let y = 0; y < H; y++) { const f = fLo * Math.exp(lr * (1 - y / (H - 1))); binOf[y] = Math.min(N / 2 - 1, Math.max(1, Math.round(f / sr * N))); }
    const col = new Float32Array(H); let gmax = -1e9; const all = new Float32Array(cols * H);
    for (let x = 0; x < cols; x++) {
      const s0 = skip + x * hop;
      for (let i = 0; i < N; i++) { const k = s0 + i; re[i] = ((L[k] || 0) + (R[k] || 0)) * 0.5 * win[i]; im[i] = 0; }
      fft(re, im);
      for (let y = 0; y < H; y++) { const b = binOf[y], b2 = y < H - 1 ? binOf[y + 1] : b; let m = 0; for (let q = Math.min(b, b2); q <= Math.max(b, b2); q++) m = Math.max(m, re[q] * re[q] + im[q] * im[q]); col[y] = 10 * Math.log10(m + 1e-12); if (col[y] > gmax) gmax = col[y]; }
      all.set(col, x * H);
    }
    for (let x = 0; x < cols; x++) for (let y = 0; y < H; y++) {
      const v = (all[x * H + y] - gmax + 85) / 85; const [r, g, b] = cmap(v);
      const o = (y * cols + x) * 4; img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
    this.g2.putImageData(img, 0, 0);
    const ax = this.el.querySelectorAll('.ax span'); ax[0].textContent = '4 s · 35 Hz–11 kHz (log)'; ax[1].textContent = `${(L.length / sr).toFixed(0)} s`;
  }

  _text(d) {
    const m = d.music || {}, a = d.ambience || {};
    const [ttl, sub] = String(m.label || m.style || 'Audio').split(' — ');
    this.el.querySelector('.t').textContent = '♪ ' + ttl;
    this.el.querySelector('.n').textContent = [sub, m.note, m.art && `art: ${m.art}`].filter(Boolean).join(' · ');
    const beds = Object.entries(a.beds || {}).filter(([, v]) => v > 0.004).map(([k]) => `<span class="amb">${k}</span>`).join('');
    const evs = Object.entries(a.events || {}).map(([k, v]) => `${k}×${v}`).join(' ');
    const rows = [
      ['key', `${m.key || '—'} · ${m.bpm || '—'} bpm · ${m.meter || 4}/4${m.swing && m.swing !== 0.5 ? ' swing ' + m.swing : ''}`],
      ['form', m.section ? `${m.section.kind} §${m.section.idx} · ${m.section.bars} bars · energy ${m.energy}` : '—'],
      ['chords', (m.recentChords || []).slice(-6).join(' → ') || '—'],
      ['layers', `<span class="chips">${(m.layers || []).map((l) => `<span class="${l.on ? 'on' : ''}">${l.id}:${l.inst}</span>`).join('')}</span>`],
      ['ambience', `<span class="chips">${beds || '<span>—</span>'}</span> ${evs}`],
      ['mix', d.mix ? `${d.mix.reverb} ${d.mix.reverbSeconds}s IR · echo ${(d.mix.echo?.time || 0).toFixed(2)}s · voices ${d.voices?.created ?? 0}${d.mix.levels ? ` · ${d.mix.levels.rmsDb} dB RMS` : ''}` : '—'],
    ];
    this.el.querySelector('.g').innerHTML = rows.map(([k, v]) => `<div class="k">${k}</div><div>${v}</div>`).join('');
  }

  update(dt) {
    this.t += dt;
    const h = this.host;
    if (!h.ctx || !h.mix) return;
    if (!this._live || !this._liveLbl) { this._live = this._liveLbl = true; this.el.querySelector('.s').textContent = 'live'; const ax = this.el.querySelectorAll('.ax span'); ax[0].textContent = 'live · 35 Hz–22 kHz (log)'; ax[1].textContent = 'now'; }
    // scrolling live spectrogram from the master analyser
    const an = h.mix.analyser; const n = an.frequencyBinCount;
    if (!this._fb || this._fb.length !== n) this._fb = new Float32Array(n);
    an.getFloatFrequencyData(this._fb);
    const g = this.g2, W = this.cv.width, H = this.cv.height, sr = h.ctx.sampleRate;
    g.drawImage(this.cv, -2, 0);
    const lr = Math.log((sr / 2) / 35);
    for (let y = 0; y < H; y++) {
      const f = 35 * Math.exp(lr * (1 - y / (H - 1))); const b = Math.min(n - 1, Math.round(f / (sr / 2) * n));
      const [r, gg, bb] = cmap((this._fb[b] + 100) / 80);
      g.fillStyle = `rgb(${r | 0},${gg | 0},${bb | 0})`; g.fillRect(W - 2, y, 2, 1);
    }
    if (this.t > 0.5) { this.t = 0; try { this._text(h.debug()); } catch (_) { /* ignore */ } }
  }
}
