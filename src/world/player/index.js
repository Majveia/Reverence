// Player subsystem (order 50). OWNED BY THE PLAYER TRACK.
// The explorer: procedural character + flow-state movement + camera. See Player.js and
// docs/tracks/player.md. URL spawn params: lat, lon, yaw, pitch, alt, tod, view=surface|fp|fly|orbit,
// plus player extras: act=slide|glide, camyaw (deg, camera around the hero), zoom (arm multiplier), fov.
import { Player } from './Player.js';

export default {
  name: 'player',
  order: 50,
  async create(world) { return new Player(world); },
};
