// Reverence — boot.
import './core/hashParams.js'; // must stay first: later imports read location.search at load
import './shaders/chunks.js';
import { Engine } from './core/Engine.js';
import { Params } from './core/Params.js';
import { Sentinel } from './core/Sentinel.js';
import { events } from './core/events.js';

async function boot() {
  // Did the previous page in this tab die in the foreground (out of memory)? Then boot one tier lower with
  // the small cosmic web instead of crashing again at the same quality (core/Sentinel.js). Never in captures.
  const crash = Params.shot ? null : Sentinel.check();
  const crashed = !!crash?.crashed;
  const engine = new Engine({ crashTier: crashed ? crash.prev.tier : undefined, tierCap: crash?.cap ?? undefined });
  window.__engine = engine;
  if (!engine.shot) {
    const tier = engine.quality.tier;
    if (crashed) {
      console.warn(`[boot] the previous page died at '${crash.prev.tier}' (in ${crash.prev.mode || 'boot'}): starting at '${tier}'`);
      Sentinel.setCap(tier);
      // an explicit ?q= (the menu's quality reload) would put a reload straight back at the tier that died
      if (Params.quality) {
        try { const u = new URL(location.href); u.searchParams.set('q', tier); history.replaceState(history.state, '', u.pathname + u.search + u.hash); } catch (_) { /* ignore */ }
      }
    }
    Sentinel.start({ tier, mode: Params.mode }, crashed ? (crash.prev.n || 0) + 1 : 0);
    events.on('mode:shown', (e) => Sentinel.update({ mode: e?.name ?? null }));
  }
  await engine.init();
  engine.start();

  const mode = engine.director.loaders[Params.mode] ? Params.mode : 'cosmic';
  const ok = await engine.director.go(mode, { ...Object.fromEntries(Params.raw.entries()) }, { transition: 'none', push: false });
  // (live play recovers a failed scale itself — director._recover; captures fall back here)
  if (!ok && mode !== 'cosmic' && !engine.director.current?.entered) await engine.director.go('cosmic', {}, { transition: 'none', push: false });
  if (!engine.shot) engine.director.fade(0, 1600);
  if (crashed) engine._notifyDegraded('crash', crash.prev.tier);
}

boot().catch((e) => {
  console.error('[boot] fatal', e);
  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;inset:auto 0 0 0;color:#f88;font:12px monospace;padding:12px;z-index:99;white-space:pre-wrap';
  el.textContent = 'Reverence failed to start: ' + (e?.stack || e);
  document.body.appendChild(el);
  document.getElementById('rv-fade').style.opacity = 0;
});
