#!/usr/bin/env node
/*
 * Headless screenshot harness (Playwright + software WebGL2).
 *
 *   node tools/shot.cjs --q "realm=system&shot=ridge" --out shots/ridge.png
 *
 * Options
 *   --q "<query>"      URL query appended to /?harness=1&  (see CLAUDE.md → "URL parameters")
 *   --out <file.png>   output path (default shots/shot.png); directories are created
 *   --w / --h          viewport size (default 1280x720);  --dpr <n> device scale factor (default 1)
 *   --frames <n>       frames to render after the scene reports idle (default 40)
 *   --eval "<js>"      JS evaluated in the page after ready, before settling (may be async; has `RV` in scope)
 *   --after "<js>"     JS evaluated after settling, right before the screenshot
 *   --print "<js>"     JS expression/body evaluated after settling; its (JSON-serialisable) return value is printed as "print"
 *                        e.g. --print "return RV.realm.describe()" 
 *   --script <file>    CommonJS module exporting async ({page, shot, settle, RV}) => {} for multi-shot scenarios.
 *                        shot(name) saves <outdir>/<name>.png,  settle(frames) waits for idle + frames
 *   --mobile           emulate a phone (touch, 844x390 landscape, dpr 2)
 *   --port <n>         shared dev server port (default 8080); if nothing listens there a private server is started
 *                        on a free port for the duration of this run
 *   --timeout <ms>     overall timeout (default 240000)
 *   --ui 0|1           hide/show DOM UI (default: hidden unless the query sets ui=1)
 *
 * Prints a JSON summary: console errors/warnings, render stats (draw calls, triangles), frame time.
 * Exit code 1 if the page threw errors, 2 on timeout.
 */
const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { const k = a[i].slice(2); const v = (a[i + 1] === undefined || a[i + 1].startsWith('--')) ? true : a[++i]; o[k] = v; }
  }
  return o;
}

function portOpen(port) {
  return new Promise((res) => {
    const s = net.createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
  });
}

(async () => {
  const o = args();
  const port = Number(o.port) || 8080;
  const root = path.resolve(__dirname, '..');
  const out = path.resolve(root, o.out || 'shots/shot.png');
  const outDir = path.dirname(out);
  fs.mkdirSync(outDir, { recursive: true });
  const timeout = Number(o.timeout) || 240000;
  const frames = Number(o.frames) || 40;

  // Global concurrency limit: many agents share this 4-core box, and each software-GL Chromium is heavy.
  const SLOTS = Number(process.env.RV_SHOT_SLOTS) || 3;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let slot = null;
  while (!slot) {
    for (let i = 0; i < SLOTS && !slot; i++) {
      const dir = `/tmp/rv-shot-slot-${i}`;
      try { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'pid'), String(process.pid)); slot = dir; }
      catch {
        try { process.kill(Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8')), 0); }
        catch (e) { if (e.code === 'ESRCH' || e.code === 'ENOENT') { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } }
      }
    }
    if (!slot) await sleep(400 + Math.random() * 600);
  }
  process.on('exit', () => { try { fs.rmSync(slot, { recursive: true, force: true }); } catch {} });

  // Use the shared dev server if one is listening; otherwise start a private one on a free port (so concurrent
  // harness runs never depend on each other's server lifetime).
  let server = null, usePort = port;
  if (!(await portOpen(port))) {
    usePort = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
    server = spawn(process.execPath, [path.join(root, 'tools/serve.mjs'), String(usePort), '--quiet'], { stdio: 'ignore', detached: false });
    for (let i = 0; i < 80 && !(await portOpen(usePort)); i++) await new Promise((r) => setTimeout(r, 100));
  }

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  const ctxOpts = o.mobile
    ? { ...devices['iPhone 13 landscape'], viewport: { width: Number(o.w) || 844, height: Number(o.h) || 390 } }
    : { viewport: { width: Number(o.w) || 1280, height: Number(o.h) || 720 }, deviceScaleFactor: Number(o.dpr) || 1 };
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();

  const logs = { errors: [], warnings: [] };
  page.on('console', (m) => {
    const t = m.type(); const text = m.text();
    if (t === 'error') logs.errors.push(text.slice(0, 600));
    else if (t === 'warning' && !/GPU stall|Automatic fallback to software|GroupMarkerNotSet/i.test(text)) logs.warnings.push(text.slice(0, 300));
  });
  page.on('pageerror', (e) => logs.errors.push('pageerror: ' + String(e && e.stack || e).slice(0, 800)));
  page.on('requestfailed', (r) => logs.errors.push('requestfailed: ' + r.url()));
  page.on('response', (r) => { if (r.status() >= 400) logs.errors.push(`http ${r.status()}: ${r.url()}`); });

  let q = String(o.q || '');
  if (!/(^|&)ui=/.test(q) && o.ui === undefined) q += (q ? '&' : '') + 'ui=0';
  if (o.ui !== undefined) q += (q ? '&' : '') + 'ui=' + o.ui;
  const url = `http://localhost:${usePort}/?harness=1${q ? '&' + q : ''}`;

  let code = 0;
  const killer = setTimeout(async () => {
    console.log(JSON.stringify({ url, timeout: true, ...logs }, null, 1));
    try { await page.screenshot({ path: out }); } catch {}
    await browser.close(); if (server) server.kill(); process.exit(2);
  }, timeout);

  const settle = async (n = frames) => {
    await page.evaluate((n) => window.RV.settle(n), n);
  };
  const shot = async (name) => {
    const file = name ? path.join(outDir, name.endsWith('.png') ? name : name + '.png') : out;
    await page.screenshot({ path: file });
    return file;
  };

  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.RV && window.RV.ready === true, null, { timeout: timeout - 5000, polling: 250 });
    if (o.eval) await page.evaluate(`(async () => { ${o.eval} })()`);
    if (o.script) {
      const fn = require(path.resolve(String(o.script)));
      await fn({ page, shot, settle, outDir });
    } else {
      await settle(frames);
      if (o.after) { await page.evaluate(`(async () => { ${o.after} })()`); await settle(2); }
      await shot();
    }
    let printed;
    if (o.print) { try { printed = await page.evaluate(`(async () => { ${/\breturn\b/.test(o.print) ? o.print : 'return (' + o.print + ')'} })()`); } catch (e) { printed = 'print failed: ' + e.message; } }
    const stats = await page.evaluate(() => window.RV.stats ? window.RV.stats() : null);
    console.log(JSON.stringify({ url, out: o.script ? outDir : out, stats, ...(o.print ? { print: printed } : {}), ...logs }, null, 1));
    if (logs.errors.length) code = 1;
  } catch (e) {
    console.log(JSON.stringify({ url, exception: String(e && e.message || e).slice(0, 800), ...logs }, null, 1));
    try { await page.screenshot({ path: out }); } catch {}
    code = 1;
  }
  clearTimeout(killer);
  await browser.close();
  if (server) server.kill();
  process.exit(code);
})();
