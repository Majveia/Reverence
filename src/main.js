// Reverence — boot.
import './core/hashParams.js'; // must stay first: later imports read location.search at load
import './shaders/chunks.js';
import { Engine } from './core/Engine.js';
import { Params } from './core/Params.js';

async function boot() {
  const engine = new Engine();
  window.__engine = engine;
  await engine.init();
  engine.start();

  const mode = engine.director.loaders[Params.mode] ? Params.mode : 'cosmic';
  const ok = await engine.director.go(mode, { ...Object.fromEntries(Params.raw.entries()) }, { transition: 'none', push: false });
  if (!ok && mode !== 'cosmic') await engine.director.go('cosmic', {}, { transition: 'none', push: false });
  if (!engine.shot) engine.director.fade(0, 1600);
}

boot().catch((e) => {
  console.error('[boot] fatal', e);
  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;inset:auto 0 0 0;color:#f88;font:12px monospace;padding:12px;z-index:99;white-space:pre-wrap';
  el.textContent = 'Reverence failed to start: ' + (e?.stack || e);
  document.body.appendChild(el);
  document.getElementById('rv-fade').style.opacity = 0;
});
