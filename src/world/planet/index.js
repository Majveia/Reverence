// Planet subsystem (order 0): creates world.surface for rocky bodies. OWNED BY THE TERRAIN TRACK.
//
// Landmarks (season 2): `world.surface.landmarks` (also `world.get('terrain').landmarks`) =
//   { mountain: {kind:'volcano', lat, lon, dir, pos, height, peak, radius, snowline},
//     sacred: [{kind:'shrine'|'tree'|'floating'|'arch', lat, lon, dir, pos, height, radius, ...}],
//     spawn: {lat, lon, toMountain, mountainDist}, views: {mountain|arch|floating: {lat, lon, yaw, pitch}} }
// Subsystems created before the terrain (space, order 5) read `world.get('terrain')?.landmarks`: a provisional
// entry carrying the same landmarks is registered here and replaced by the real terrain instance at order 10.
import * as THREE from 'three';
import { PlanetSurface } from './PlanetSurface.js';

/** Adds THREE conveniences (pos / up vectors) to the generator's plain landmark records. */
export function decorateLandmarks(surface) {
  const L = surface?.landmarks;
  if (!L || L._decorated) return L || null;
  const R = surface.radius;
  try { surface.findViews?.(); } catch (_) { /* optional */ }
  const dec = (o, h) => {
    if (!o || !o.dir) return;
    o.up = new THREE.Vector3(o.dir[0], o.dir[1], o.dir[2]);
    o.pos = o.up.clone().multiplyScalar(R + Math.max(h ?? o.height ?? 0, Number.isFinite(surface.seaLevel) ? surface.seaLevel : -1e9));
  };
  dec(L.mountain, L.mountain?.height);
  for (const s of L.sacred || []) {
    dec(s, s.height);
    if (s.islands) for (const i of s.islands) { i.up = new THREE.Vector3(i.dir[0], i.dir[1], i.dir[2]); i.pos = i.up.clone().multiplyScalar(R + i.alt); }
  }
  if (L.spawn) dec(L.spawn, 0);
  Object.defineProperty(L, '_decorated', { value: true });
  return L;
}

export default {
  name: 'planet',
  order: 0,
  async create(world) {
    if (world.body.isGas) { world.surface = null; return { getState: () => ({ gas: true }) }; }
    world.surface = new PlanetSurface(world.body);
    const landmarks = (() => { try { return decorateLandmarks(world.surface); } catch (e) { console.warn('[planet] landmarks', e); return null; } })();
    // provisional 'terrain' entry for subsystems created before the terrain (replaced at order 10)
    try {
      if (landmarks && world.systems && !world.systems.has('terrain')) {
        const S = world.surface;
        world.systems.set('terrain', {
          provisional: true, landmarks,
          lodAt: () => 1, renderedHeight: (x, y, z) => S.height(x, y, z),
        });
      }
    } catch (_) { /* optional */ }
    return {
      landmarks,
      getState: () => ({ seaLevel: world.surface.seaLevel, amp: Math.round(world.surface.amp), mountain: landmarks?.mountain ? { lat: landmarks.mountain.lat, lon: landmarks.mountain.lon, h: Math.round(landmarks.mountain.height) } : null }),
    };
  },
};
