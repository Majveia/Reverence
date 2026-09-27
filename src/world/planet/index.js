// Planet subsystem (order 0): creates world.surface for rocky bodies. OWNED BY THE TERRAIN TRACK.
import { PlanetSurface } from './PlanetSurface.js';

export default {
  name: 'planet',
  order: 0,
  async create(world) {
    if (world.body.isGas) { world.surface = null; return { getState: () => ({ gas: true }) }; }
    world.surface = new PlanetSurface(world.body);
    return {
      getState: () => ({ seaLevel: world.surface.seaLevel, amp: Math.round(world.surface.amp) }),
    };
  },
};
