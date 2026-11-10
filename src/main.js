// Boot.  Creates the engine, loads every module (each optional and isolated), then starts the journey.
import * as THREE from 'three';
import { Engine } from './core/engine.js';

const params = Object.fromEntries(new URLSearchParams(location.search));
const canvas = document.getElementById('view');
const engine = new Engine(canvas, params);

/** Debug / automation handle.  `RV.ready` flips true once the first realm is on screen. */
const RV = (window.RV = {
  engine, THREE, ready: false, error: null,
  settle: (frames) => engine.settle(frames),
  stats: () => engine.stats(),
  travel: (target, opts) => engine.travel(target, opts),
  get realm() { return engine.realm; },
});

async function boot() {
  // realms
  const realmDefs = [['cosmos', 'realms/cosmos/index.js'], ['galaxy', 'realms/galaxy/index.js'], ['source', 'realms/source/index.js'], ['system', 'realms/system/index.js']];
  const want = params.realm;
  await Promise.all(realmDefs.map(async ([name, path]) => {
    if (engine.harness && want && want !== name && params.all !== '1') return;        // harness: load only what the shot needs
    const mod = await engine.load(path, name);
    if (!mod?.default) return;
    try { const realm = new mod.default(engine); await realm.init?.(); engine.registerRealm(realm); }
    catch (e) { console.error(`[boot] realm "${name}" failed to init`, e); }
  }));

  // cross-cutting modules
  const [audioMod, uiMod, introMod] = await Promise.all([
    params.audio === '0' ? null : engine.load('audio/index.js', 'audio'),
    engine.load('ui/index.js', 'ui'),
    engine.load('intro/index.js', 'intro'),
  ]);
  for (const [key, mod] of [['audio', audioMod], ['ui', uiMod], ['intro', introMod]]) {
    if (!mod?.default) continue;
    try { engine[key] = await mod.default(engine); await engine[key]?.init?.(); } catch (e) { console.error(`[boot] ${key} failed`, e); engine[key] = null; }
  }

  engine.start();

  const direct = want || params.nointro === '1' || engine.harness;
  if (direct && params.intro !== '1') {
    const realm = engine.realms[want] ? want : engine.realms.system ? 'system' : Object.keys(engine.realms)[0];
    await engine.travel({ realm }, { instant: true });
    if (!engine.harness) engine.ui?.showStart?.({ quick: true });
  } else {
    // The entrance: a still title, one gesture to wake the sound, then the overture.
    await engine.ui?.showStart?.({});
    if (engine.intro?.play) await engine.intro.play();
    if (!engine.realm || engine.realm.name === 'intro') await engine.travel({ realm: engine.realms.system ? 'system' : Object.keys(engine.realms)[0] }, { instant: !engine.realm });
  }
  RV.ready = true;
  engine.events.emit('ready');
}

boot().catch((e) => { console.error('[boot] fatal', e); RV.error = String(e?.stack || e); RV.ready = true; });
