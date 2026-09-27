#!/usr/bin/env node
// Smoke test: production build + boot every mode headlessly and report console errors.
//   node tools/check.mjs            (build + modes)
//   node tools/check.mjs --nobuild  (modes only)
import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const nobuild = process.argv.includes('--nobuild');
let failed = false;

if (!nobuild) {
  console.log('[check] vite build …');
  try {
    execSync('npx vite build --logLevel error', { cwd: root, stdio: 'pipe', timeout: 300000 });
    console.log('[check] build OK');
  } catch (e) {
    failed = true;
    console.log('[check] BUILD FAILED\n' + (e.stdout?.toString() || '') + (e.stderr?.toString() || ''));
  }
}

const scenes = [
  ['cosmic', '/?mode=cosmic'],
  ['galaxy', '/?mode=galaxy&galaxy=3'],
  ['system-orbit', '/?mode=system&galaxy=0&star=7&view=orbit'],
  ['system-surface', '/?mode=system&galaxy=0&star=7&view=surface&tod=0.35'],
];
for (const [name, url] of scenes) {
  const r = spawnSync('node', ['tools/shoot.mjs', '--url', url, '--out', `shots/check-${name}.png`, '--quiet', '--w', '960', '--h', '540', '--timeout', '180'], { cwd: root, encoding: 'utf8', timeout: 400000 });
  const ok = r.status === 0;
  if (!ok) failed = true;
  console.log(`[check] ${ok ? 'OK  ' : 'FAIL'} ${name} (exit ${r.status})`);
  if (!ok) console.log((r.stdout || '').split('\n').filter((l) => /✗|FAILED|state/.test(l)).slice(0, 12).join('\n'));
}
console.log(failed ? '[check] FAILED' : '[check] ALL OK');
process.exit(failed ? 1 : 0);
