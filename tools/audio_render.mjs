#!/usr/bin/env node
// Reverence audio renderer (AUDIO track) — renders N seconds of a scene through an OfflineAudioContext
// in headless Chromium (the exact same Audio.js graph the game runs) and writes, per scenario:
//   <out>/<name>.wav            16-bit stereo PCM
//   <out>/<name>.png            log-frequency spectrogram + loudness strip + event timeline (needs numpy/matplotlib)
//   <out>/<name>.json           composer / ambience / mix debug state + audio metrics
//
// Usage:
//   node tools/audio_render.mjs --preset ghibli --out /tmp/audio            (one named scenario)
//   node tools/audio_render.mjs --all --out /tmp/audio --seconds 16         (every preset)
//   node tools/audio_render.mjs --scene surface --art bebop --seconds 30 --over '{"night":1,"city":0.8}' \
//        --params '{"speed":4}' --walk 2 --surface grass --events '[{"t":5,"play":"discover"}]' --name test --out dir
//   node tools/audio_render.mjs --list
// Options: --music-only (mute ambience/sfx) --only a,b,c (subset of --all) --seconds (default 20) --rate (44100) --seed --quality low|med|high --base <dev server url>
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export const PRESETS = {
  cosmic: { scene: 'cosmic', params: { cosmicGrowth: 0.2 }, events: [{ t: 8, param: 'cosmicGrowth', value: 0.8 }, { t: 12, play: 'whoosh' }] },
  galaxy: { scene: 'galaxy', events: [{ t: 6, play: 'select' }, { t: 10, play: 'whoosh' }] },
  space: { scene: 'space', params: { engine: 0.4, engineType: 'ship' }, over: { inShip: true } },
  ghibli: { art: 'ghibli', over: { night: 0, wind: 0.4, flora: 0.9 }, params: { speed: 3 }, walk: 1.9, surface: 'grass', events: [{ t: 9, play: 'discover', opts: { kind: 'village' } }] },
  botw: { art: 'botw', over: { night: 0.1, wind: 0.5, flora: 0.8 }, params: { speed: 4 }, walk: 2.1, surface: 'grass' },
  'botw-glide': { art: 'botw', over: { wind: 0.6, altitude: 120 }, params: { speed: 18, glide: 1, wind: 0.8 }, events: [{ t: 1, play: 'glider', opts: { open: true } }] },
  rogerdean: { art: 'rogerdean', over: { wind: 0.3, shore: 0.6 } },
  nausicaa: { art: 'nausicaa', over: { wind: 0.5, fauna: 0.9 } },
  bierstadt: { art: 'bierstadt', over: { wind: 0.3, dawn: 1, night: 0.3 } },
  outerwilds: { art: 'outerwilds', over: { night: 0.9, flora: 0.8 } },
  moebius: { art: 'moebius', type: 'desert', over: { wind: 0.7, hot: 1, flora: 0.2 }, params: { speed: 3 }, walk: 1.8, surface: 'sand' },
  dune: { art: 'villeneuve', type: 'desert', over: { wind: 0.9, flora: 0.05, fauna: 0.3 } },
  bladerunner: { art: 'bladerunner', over: { night: 0.9, rain: 0.8, city: 0.8, cityStyle: 'neon', storm: 0.5 }, events: [{ t: 7, over: { flash: 1 } }, { t: 7.3, over: { flash: 0 } }] },
  bebop: { art: 'bebop', over: { night: 0.4, city: 0.5, cityStyle: 'village' } },
  stalenhag: { art: 'stalenhag', over: { wind: 0.4, city: 0.5, cityStyle: 'industrial' }, params: { engine: 0.7, engineType: 'rover', speed: 14 } },
  nms: { art: 'nms', over: { flora: 1, fauna: 1 }, params: { speed: 30, engine: 0.8, engineType: 'bike' } },
  rickmorty: { art: 'rickmorty', over: { flora: 1, fauna: 0.8 } },
  tarkovsky: { art: 'tarkovsky', over: { wind: 0.2, rain: 0.3, shore: 0.4 } },
  kubrick: { art: 'kubrick', type: 'barren', over: { flora: 0, fauna: 0, wind: 0.05 } },
  crystal: { art: 'crystal', over: { flora: 0.6 } },
  friedrich: { art: 'friedrich', type: 'arctic', over: { wind: 0.8, snow: 0.6, cold: true } },
  'shore-night': { art: 'ghibli', over: { night: 1, shore: 1, wind: 0.4, flora: 0.8 } },
  'bike-ride': { art: 'botw', params: { engine: 0.9, engineType: 'bike', speed: 45, boost: 0 }, events: [{ t: 4, param: 'boost', value: 1 }, { t: 4, play: 'boost' }, { t: 7, param: 'boost', value: 0 }, { t: 10, param: 'speed', value: 15 }] },
  'sfx-tour': { art: 'ghibli', seconds: 16, over: { wind: 0.2 }, events: [
    { t: 0.5, play: 'step', opts: { surface: 'grass' } }, { t: 0.9, play: 'step', opts: { surface: 'rock' } }, { t: 1.3, play: 'step', opts: { surface: 'sand' } }, { t: 1.7, play: 'step', opts: { surface: 'snow' } },
    { t: 2.2, play: 'jump' }, { t: 3.0, play: 'land', opts: { intensity: 0.8 } }, { t: 3.6, play: 'glider', opts: { open: true } }, { t: 4.5, play: 'splash', opts: { intensity: 0.7 } },
    { t: 5.4, play: 'ui.click' }, { t: 5.8, play: 'ui.back' }, { t: 6.4, play: 'discover', opts: { kind: 'monument' } }, { t: 9, play: 'vehicle.enter', opts: { type: 'bike' } },
    { t: 10, play: 'impact', opts: { intensity: 0.8 } }, { t: 11, play: 'takeoff' }, { t: 12.5, play: 'pulse', opts: { on: true } }, { t: 14.2, play: 'warp' }] },
};

if (flag('list')) { console.log(Object.keys(PRESETS).join('\n')); process.exit(0); }

const outDir = path.resolve(opt('out', path.join(root, 'shots', 'audio')));
fs.mkdirSync(outDir, { recursive: true });
const seconds = +opt('seconds', 20);
const J = (s, d) => (s ? JSON.parse(s) : d);

let jobs = [];
if (flag('all')) jobs = Object.entries(PRESETS).map(([name, p]) => ({ name, ...p }));
else if (opt('preset')) { const n = opt('preset'); if (!PRESETS[n]) { console.error('unknown preset', n); process.exit(1); } jobs = [{ name: n, ...PRESETS[n] }]; }
else jobs = [{ name: opt('name', `${opt('scene', 'surface')}-${opt('art', 'ghibli')}`), scene: opt('scene', 'surface'), art: opt('art', 'ghibli'), over: J(opt('over'), {}), params: J(opt('params'), {}), events: J(opt('events'), []), walk: +opt('walk', 0), surface: opt('surface', 'grass'), type: opt('type') }];
if (flag('music-only')) for (const j of jobs) { j.buses = { amb: 0, sfx: 0, ui: 0 }; j.walk = 0; j.name += '-music'; }
if (opt('only')) { const keep = opt('only').split(','); jobs = jobs.filter((j) => keep.some((k) => j.name === k || j.name.startsWith(k + '-music'))); }
for (const j of jobs) { j.seconds = j.seconds ?? seconds; j.sampleRate = +opt('rate', 44100); j.seed = +opt('seed', j.seed ?? 1234); j.quality = opt('quality', 'high'); j.scene = j.scene || 'surface'; }

// ---- dev server (reuse the shared one; start a private vite if it is down)
const base = opt('base', process.env.RV_BASE || 'http://localhost:5173');
async function reachable(u) { try { const r = await fetch(u, { signal: AbortSignal.timeout(3000) }); return r.ok; } catch { return false; } }
function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); }); }
let server = null, baseUrl = base;
if (!(await reachable(base + '/'))) {
  const port = await freePort(); baseUrl = `http://localhost:${port}`;
  server = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore', detached: true, env: { ...process.env, RV_NO_HMR: '1' } });
  for (let i = 0; i < 60 && !(await reachable(baseUrl + '/')); i++) await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--disable-gpu'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
await page.goto(baseUrl + '/src/audio/Audio.js', { waitUntil: 'load' });

function wav(file, L, R, sr) {
  const n = L.length, b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { b.writeInt16LE(L[i], 44 + i * 4); b.writeInt16LE(R[i], 46 + i * 4); }
  fs.writeFileSync(file, b);
}

const PY = String.raw`
import sys, json, wave, numpy as np
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
wavf, pngf, jsonf = sys.argv[1], sys.argv[2], sys.argv[3]
info = json.load(open(jsonf))
w = wave.open(wavf); sr = w.getframerate(); n = w.getnframes()
x = np.frombuffer(w.readframes(n), dtype=np.int16).reshape(-1, 2).astype(np.float32) / 32768
m = x.mean(axis=1)
N, H = 4096, 1024
win = np.hanning(N)
frames = 1 + max(0, (len(m) - N) // H)
S = np.stack([np.abs(np.fft.rfft(m[i*H:i*H+N] * win)) for i in range(frames)], axis=1) if frames > 0 else np.zeros((N//2+1, 1))
db = 20 * np.log10(S + 1e-7); db -= db.max()
freqs = np.fft.rfftfreq(N, 1/sr); times = np.arange(frames) * H / sr
fig = plt.figure(figsize=(14, 7.2), facecolor='#07080b')
gs = fig.add_gridspec(3, 1, height_ratios=[5, 1.1, 0.5], hspace=0.08)
ax = fig.add_subplot(gs[0]); ax.set_facecolor('#000')
ax.pcolormesh(times, freqs[1:], db[1:], shading='auto', cmap='magma', vmin=-90, vmax=0)
ax.set_yscale('log'); ax.set_ylim(30, sr/2); ax.set_xlim(0, len(m)/sr)
ax.set_ylabel('Hz', color='#bbb'); ax.tick_params(colors='#999', labelbottom=False)
for s in ax.spines.values(): s.set_color('#333')
mu = info.get('debug', {}).get('music', {}) or {}
title = f"{info['name']}  ·  {mu.get('label') or ''}  {('· ' + mu['note']) if mu.get('note') else ''}"
ax.set_title(title, color='#eee', fontsize=12, loc='left')
met = info['metrics']
ax.text(0.995, 0.98, f"key {mu.get('key','?')} · {mu.get('bpm','?')} bpm · {mu.get('meter','?')}/4\npeak {met['peakDb']} dBFS · RMS {met['rmsDb']} dBFS · LUFS≈{met['lufs']}\ncentroid {met['centroid']} Hz · width {met['width']} · clipped {met['clipped']}",
        transform=ax.transAxes, ha='right', va='top', color='#ddd', fontsize=9, family='monospace', bbox=dict(facecolor='#000a', edgecolor='#333'))
ax2 = fig.add_subplot(gs[1], sharex=ax); ax2.set_facecolor('#000')
blk = int(sr * 0.05); nb = len(m) // blk
rms = np.sqrt((m[:nb*blk].reshape(nb, blk)**2).mean(axis=1) + 1e-12); pk = np.abs(m[:nb*blk]).reshape(nb, blk).max(axis=1)
tt = np.arange(nb) * blk / sr
ax2.fill_between(tt, 20*np.log10(pk+1e-9), -80, color='#4a3a6a'); ax2.fill_between(tt, 20*np.log10(rms), -80, color='#d88cff')
ax2.set_ylim(-60, 0); ax2.set_ylabel('dB', color='#bbb'); ax2.tick_params(colors='#999', labelbottom=False)
for s in ax2.spines.values(): s.set_color('#333')
ax3 = fig.add_subplot(gs[2], sharex=ax); ax3.set_facecolor('#000'); ax3.set_yticks([])
for (t, lab) in info.get('timeline', []):
    ax3.axvline(t, color='#6fe', lw=0.8); ax3.text(t, 0.5, ' ' + str(lab), color='#9fe', fontsize=7, va='center', rotation=0)
ax3.set_xlabel('seconds', color='#bbb'); ax3.tick_params(colors='#999')
for s in ax3.spines.values(): s.set_color('#333')
fig.savefig(pngf, dpi=90, facecolor=fig.get_facecolor(), bbox_inches='tight')
`;
const pyFile = path.join(outDir, '.spectrogram.py');
fs.writeFileSync(pyFile, PY);

let failed = false;
for (const job of jobs) {
  const t0 = Date.now();
  let res;
  try {
    res = await page.evaluate(async (o) => {
      const m = await import('/src/audio/Audio.js');
      const r = await m.Audio.renderOffline(o);
      const [L, R] = r.channels; const n = L.length;
      const i16 = new Int16Array(n * 2);
      let peak = 0, sum = 0, clipped = 0, sumLR = 0, sumL2 = 0, sumR2 = 0, silent = 0;
      for (let i = 0; i < n; i++) {
        const l = L[i], rr = R[i];
        const al = Math.abs(l), ar = Math.abs(rr); if (al > peak) peak = al; if (ar > peak) peak = ar;
        if (al >= 0.999 || ar >= 0.999) clipped++;
        sum += l * l + rr * rr; sumLR += l * rr; sumL2 += l * l; sumR2 += rr * rr;
        i16[i * 2] = Math.max(-32768, Math.min(32767, Math.round(l * 32767)));
        i16[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(rr * 32767)));
      }
      // silence ratio over 100 ms windows
      const W = Math.floor(r.sampleRate * 0.1); let wins = 0;
      for (let s = 0; s + W <= n; s += W) { let e = 0; for (let i = s; i < s + W; i += 4) e += L[i] * L[i]; wins++; if (Math.sqrt(e / (W / 4)) < 0.001) silent++; }
      // crude spectral centroid via zero-crossing proxy + K-weighted-ish loudness proxy
      let zc = 0; for (let i = 1; i < n; i++) if ((L[i - 1] < 0) !== (L[i] < 0)) zc++;
      const bytes = new Uint8Array(i16.buffer); let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      const rms = Math.sqrt(sum / (2 * n));
      return {
        b64: btoa(bin), sampleRate: r.sampleRate, n, debug: r.debug, timeline: r.timeline,
        metrics: { peakDb: +(20 * Math.log10(peak + 1e-9)).toFixed(1), rmsDb: +(20 * Math.log10(rms + 1e-9)).toFixed(1), lufs: +(20 * Math.log10(rms + 1e-9) - 0.7).toFixed(1), clipped, silentPct: +(100 * silent / Math.max(1, wins)).toFixed(1), centroid: Math.round(zc / 2 / (n / r.sampleRate)), width: +(1 - sumLR / Math.sqrt(sumL2 * sumR2 + 1e-12)).toFixed(3) },
      };
    }, job);
  } catch (e) { failed = true; console.log(`[audio_render] FAIL ${job.name}: ${e.message}`); continue; }
  const buf = Buffer.from(res.b64, 'base64');
  const i16 = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  const L = new Int16Array(res.n), R = new Int16Array(res.n);
  for (let i = 0; i < res.n; i++) { L[i] = i16[i * 2]; R[i] = i16[i * 2 + 1]; }
  const base = path.join(outDir, job.name);
  wav(base + '.wav', L, R, res.sampleRate);
  const info = { name: job.name, job, metrics: res.metrics, timeline: res.timeline, debug: res.debug };
  fs.writeFileSync(base + '.json', JSON.stringify(info, null, 1));
  const py = spawnSync('python3', [pyFile, base + '.wav', base + '.png', base + '.json'], { encoding: 'utf8' });
  const pngOk = py.status === 0;
  const mu = res.debug?.music || {};
  console.log(`[audio_render] ${job.name.padEnd(12)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${mu.style}/${mu.art || '-'} ${mu.key} ${mu.bpm}bpm  peak ${res.metrics.peakDb} rms ${res.metrics.rmsDb} clip ${res.metrics.clipped} silent ${res.metrics.silentPct}%  → ${base}.wav${pngOk ? ' + .png' : ' (no png: ' + (py.stderr || '').split('\n').filter(Boolean).pop() + ')'}`);
}
if (errors.length) console.log('[audio_render] page messages:\n  ' + [...new Set(errors)].slice(0, 20).join('\n  '));
await browser.close();
if (server) { try { process.kill(-server.pid); } catch { /* ignore */ } }
process.exit(failed ? 1 : 0);
