#!/usr/bin/env node
// Reverence capture harness — headless Chromium (SwiftShader WebGL2) + deterministic __rv API.
//
// Usage:
//   node tools/shoot.mjs --url "/?mode=system&planet=0&view=surface&tod=0.3" --out shots/a.png
//   node tools/shoot.mjs --url "/?mode=cosmic" --steps '[{"advance":2},{"shot":"shots/c1.png"},{"look":[30,0]},{"advance":1},{"shot":"shots/c2.png"}]'
//
// Options:
//   --url <path?query>   page to load (shot=1 is appended automatically)
//   --out <file.png>     final screenshot (if no "shot" steps given)
//   --w/--h <px>         viewport (default 1280x720)
//   --advance <sec>      sim seconds to advance before the default shot (default 0.5)
//   --steps <json>       array of steps (see below) — or @file.json
//   --mobile             emulate a phone (390x844 @3x, touch)
//   --ui                 show UI in the capture (adds ui=1)
//   --q <tier>           quality tier (default high)
//   --base <url>         dev server (default http://localhost:5173; auto-starts vite if down)
//   --timeout <sec>      readiness timeout (default 240)
//   --quiet              only print errors + state
// Steps: {"advance":sec} {"hold":"KeyW","sec":2} {"press":"KeyE"} {"move":[x,y],"sec":2}
//        {"look":[dxDeg,dyDeg]} {"click":[px,py]} {"go":"galaxy","params":{}} {"shot":"file.png"}
//        {"eval":"js expression"} {"wait":ms} {"state":true} {"touch":[[x0,y0],[x1,y1],ms]} (swipe)
// Exit codes: 0 ok · 2 never ready / navigation failure · 3 page errors (still captures)
import { chromium, devices } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes('--' + name);

const W = +opt('w', 1280), H = +opt('h', 720);
const quiet = flag('quiet');
const base = opt('base', process.env.RV_BASE || 'http://localhost:5173');
let urlPath = opt('url', '/?mode=cosmic');
const out = opt('out', 'shots/shot.png');
const timeout = +opt('timeout', 240) * 1000;
let steps = opt('steps', null);
if (steps && steps.startsWith('@')) steps = fs.readFileSync(steps.slice(1), 'utf8');
steps = steps ? JSON.parse(steps) : [{ advance: +opt('advance', 0.5) }, { shot: out }];

const log = (...a) => { if (!quiet) console.log(...a); };

async function reachable(u) {
  try { const r = await fetch(u, { signal: AbortSignal.timeout(3000) }); return r.ok; } catch { return false; }
}
function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
}

let server = null;
let baseUrl = base;
if (!(await reachable(base + '/'))) {
  const port = await freePort();
  baseUrl = `http://localhost:${port}`;
  log(`[shoot] dev server not reachable at ${base}; starting vite on ${port}`);
  server = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), stdio: 'ignore', detached: true });
  for (let i = 0; i < 60 && !(await reachable(baseUrl + '/')); i++) await new Promise((r) => setTimeout(r, 500));
}

const sep = urlPath.includes('?') ? '&' : '?';
urlPath += `${sep}shot=1`;
if (flag('ui')) urlPath += '&ui=1';
if (!/[?&]q=/.test(urlPath)) urlPath += `&q=${opt('q', 'high')}`;
const full = baseUrl + urlPath;

// ---- render slots: cap concurrent SwiftShader browsers machine-wide (CPU/RAM protection)
const SLOTS = +(process.env.RV_SLOTS || 3);
const slotDir = '/tmp/rv-shoot-slots';
fs.mkdirSync(slotDir, { recursive: true });
let slotPath = null;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
for (let tries = 0; !slotPath; tries++) {
  for (let i = 0; i < SLOTS && !slotPath; i++) {
    const p = `${slotDir}/slot${i}`;
    try { fs.mkdirSync(p); fs.writeFileSync(`${p}/pid`, String(process.pid)); slotPath = p; }
    catch {
      try { const pid = +fs.readFileSync(`${p}/pid`, 'utf8'); if (!alive(pid)) fs.rmSync(p, { recursive: true, force: true }); } catch { /* racing */ }
    }
  }
  if (!slotPath) { if (tries % 20 === 0) log(`[shoot] waiting for a render slot (${SLOTS} busy)…`); await new Promise((r) => setTimeout(r, 1500)); }
}
const releaseSlot = () => { try { fs.rmSync(slotPath, { recursive: true, force: true }); } catch { /* ignore */ } };
process.on('exit', releaseSlot);
process.on('SIGINT', () => { releaseSlot(); process.exit(130); });
process.on('SIGTERM', () => { releaseSlot(); process.exit(143); });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-driver-bug-workarounds', '--js-flags=--max-old-space-size=4096'],
});
const ctxOpts = flag('mobile')
  ? { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }
  : { viewport: { width: W, height: H }, deviceScaleFactor: 1 };
const context = await browser.newContext(ctxOpts);
const page = await context.newPage();

const errors = [], warnings = [];
page.on('console', (m) => {
  const t = m.type(), txt = m.text();
  if (t === 'error') errors.push(txt);
  else if (t === 'warning') warnings.push(txt);
  else if (!quiet && /\[(world|engine|director|pipeline|shoot)\]/.test(txt)) console.log('  page:', txt);
});
page.on('pageerror', (e) => errors.push('PAGEERROR ' + (e.stack || e.message)));

let code = 0;
const t0 = Date.now();
try {
  log(`[shoot] ${full}`);
  await page.goto(full, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__rv && window.__rv.ready, null, { timeout, polling: 250 });
  log(`[shoot] ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const s of steps) {
    if (s.advance !== undefined) await page.evaluate((sec) => window.__rv.advance(sec), s.advance);
    else if (s.hold) await page.evaluate(([c, sec]) => window.__rv.hold(c, sec), [s.hold, s.sec ?? 1]);
    else if (s.press) await page.evaluate((c) => window.__rv.press(c), s.press);
    else if (s.move) await page.evaluate(([x, y, sec]) => window.__rv.move(x, y, sec), [s.move[0], s.move[1], s.sec ?? 1]);
    else if (s.look) await page.evaluate(([x, y]) => window.__rv.look(x, y), s.look);
    else if (s.click) await page.evaluate(([x, y]) => window.__rv.click(x, y), s.click);
    else if (s.go) { await page.evaluate(([n, p]) => window.__rv.go(n, p), [s.go, s.params || {}]); await page.waitForFunction(() => window.__rv.ready, null, { timeout, polling: 250 }); }
    else if (s.eval) { const r = await page.evaluate((src) => { try { return JSON.stringify((0, eval)(src)); } catch (e) { return 'ERR ' + e.message; } }, s.eval); console.log('[eval]', r); }
    else if (s.wait) await page.waitForTimeout(s.wait);
    else if (s.touch) {
      const [[x0, y0], [x1, y1], ms = 400] = s.touch;
      await page.touchscreen.tap(x0, y0).catch(() => {});
      // synthetic swipe via CDP
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
      const n = 12;
      for (let k = 1; k <= n; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * k / n, y: y0 + (y1 - y0) * k / n }] }); await page.waitForTimeout(ms / n); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    else if (s.state) console.log('[state]', JSON.stringify(await page.evaluate(() => window.__rv.state())));
    if (s.shot) {
      fs.mkdirSync(path.dirname(path.resolve(s.shot)), { recursive: true });
      await page.screenshot({ path: s.shot, type: s.shot.endsWith('.jpg') ? 'jpeg' : 'png', quality: s.shot.endsWith('.jpg') ? 92 : undefined });
      log(`[shoot] saved ${s.shot}`);
    }
  }
  const state = await page.evaluate(() => window.__rv.state());
  console.log('[state]', JSON.stringify(state));
} catch (e) {
  code = 2;
  console.error('[shoot] FAILED:', e.message);
  try {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    await page.screenshot({ path: out.replace(/\.(png|jpg)$/, '.failed.png') });
    console.error('[shoot] state:', JSON.stringify(await page.evaluate(() => window.__rv?.state?.())));
  } catch { /* ignore */ }
}
if (errors.length) {
  console.log(`[shoot] ${errors.length} console error(s):`);
  for (const e of [...new Set(errors)].slice(0, 25)) console.log('  ✗', e.slice(0, 600));
  if (code === 0) code = 3;
}
if (warnings.length && !quiet) {
  const uniq = [...new Set(warnings)].filter((w) => !/GPU stall|swiftshader|ReadPixels|WebGL: CONTEXT_LOST/i.test(w));
  if (uniq.length) { console.log(`[shoot] ${uniq.length} warning(s):`); for (const w of uniq.slice(0, 10)) console.log('  !', w.slice(0, 300)); }
}
log(`[shoot] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await browser.close();
if (server) { try { process.kill(-server.pid); } catch { /* ignore */ } }
process.exit(code);
