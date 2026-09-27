// Audio host (WebAudio, fully procedural — no audio files). Owned by the AUDIO track.
// API CONTRACT (keep stable):
//   audio.unlock()                      call on first user gesture (engine does this)
//   audio.setScene(name, params)        'cosmic'|'galaxy'|'space'|'surface'|'city'|'underwater'
//   audio.setParam(name, value)         e.g. 'speed' m/s, 'altitude' m, 'wind' 0..1, 'engine' 0..1,
//                                       'rain' 0..1, 'night' 0..1, 'danger' 0..1, 'boost' 0..1
//   audio.play(name, opts)              one-shots: 'ui.select','ui.back','warp','land','jump','step',
//                                       'discover','vehicle.enter','vehicle.exit','splash','boost'
//   audio.update(dt)
export class Audio {
  constructor(engine) {
    this.engine = engine;
    this.ctx = null;
    this.params = {};
    this.scene = null;
  }
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(this.ctx.destination);
    } catch (e) { console.warn('[audio] unavailable', e); }
  }
  setScene(name, params = {}) { this.scene = name; this.sceneParams = params; }
  setParam(name, value) { this.params[name] = value; }
  play(name, opts = {}) {}
  update(dt) {}
}
