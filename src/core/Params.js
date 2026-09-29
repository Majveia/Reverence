// URL parameter parsing. Every scene/state that a critic or tester needs to reach
// must be addressable by URL so screenshots are reproducible. The same parameters also work in
// the hash (#mode=galaxy&focus=core) for hosts that drop the query string (core/hashParams.js).
//
//   ?mode=cosmic|galaxy|system         which scale to boot into (default: cosmic)
//   &seed=<int>                        universe seed (default 1)
//   &galaxy=<int> &star=<int>          galaxy index / star index inside that galaxy
//   &planet=<int>                      planet index inside the system (moons: "2.1" = planet 2, moon 1)
//   &view=orbit|surface|fly|ship|bike|rover|fp   spawn state inside the system mode
//   &lat=<deg> &lon=<deg>              surface spawn location
//   &yaw=<deg> &pitch=<deg>            camera heading (0 = north) and pitch
//   &alt=<m>   &dist=<m>               altitude above ground (fly) / camera distance (orbit)
//   &tod=<0..1>                        local time of day (0 midnight, .25 sunrise, .5 noon, .75 sunset)
//   &q=low|med|high|ultra              quality tier override
//   &shot=1                            deterministic capture mode (fixed dt, no UI unless &ui=1)
//   &ui=0|1                            force UI visibility
//   &stats=1                           perf overlay
//   &debug=1                           verbose logging / debug helpers
//   &time=<sec>                        start simulation clock (e.g. cosmic web evolution time)

const url = new URL(window.location.href);
const sp = url.searchParams;

function num(name, def = undefined) {
  if (!sp.has(name)) return def;
  const v = parseFloat(sp.get(name));
  return Number.isFinite(v) ? v : def;
}
function int(name, def = undefined) {
  if (!sp.has(name)) return def;
  const v = parseInt(sp.get(name), 10);
  return Number.isFinite(v) ? v : def;
}
function str(name, def = undefined) {
  return sp.has(name) ? sp.get(name) : def;
}
function bool(name, def = false) {
  if (!sp.has(name)) return def;
  const v = sp.get(name);
  return v === '' || v === '1' || v === 'true' || v === 'yes';
}

export const Params = {
  raw: sp,
  num, int, str, bool,
  mode: str('mode', 'cosmic'),
  seed: int('seed', 1),
  galaxy: int('galaxy'),
  star: int('star'),
  planet: str('planet'),
  view: str('view'),
  lat: num('lat'),
  lon: num('lon'),
  yaw: num('yaw'),
  pitch: num('pitch'),
  alt: num('alt'),
  dist: num('dist'),
  tod: num('tod'),
  quality: str('q'),
  shot: bool('shot'),
  ui: sp.has('ui') ? bool('ui') : undefined,
  stats: bool('stats'),
  debug: bool('debug'),
  time: num('time'),
};

// Build a URL query for another state (used by the UI "share location" feature and tools).
export function buildQuery(obj) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, typeof v === 'number' ? String(Math.round(v * 1e4) / 1e4) : String(v));
  }
  return '?' + q.toString();
}
