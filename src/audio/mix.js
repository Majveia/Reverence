// Mixer (AUDIO track): buses, generated-IR convolution reverb (A/B crossfade), tempo echo,
// tape/lo-fi insert on the music bus, underwater muffle, glue compressor + brick-wall limiter,
// ducking and a metering analyser.
//
//   music ─ insert(wow/flutter delay → lowpass → drive) ─ duck ─ vol ┐
//   amb   ─ muffle LP ─ duck ─ vol ──────────────────────────────────┤
//   sfx   ─ muffle LP ─ vol ─────────────────────────────────────────┼─ pre ─ HP ─ glue comp ─ limiter ─ master ─ out
//   ui    ─ vol ─────────────────────────────────────────────────────┤
//   reverbIn ─ convolver A|B ─ return ───────────────────────────────┤
//   echoIn ─ ping-pong delay (LP in feedback) ─ return ──────────────┘
import { impulseResponse, satCurve, noiseBuffer, clamp } from './dsp.js';
import { sample } from './samples.js';

export const REVERBS = {
  cosmos: { seconds: 7.5, rt60: 7, damping: 0.35, preDelay: 0.06, early: 0.1, bloom: 0.25, width: 1 },
  cathedral: { seconds: 6, rt60: 5.2, damping: 0.45, preDelay: 0.04, early: 0.35, bloom: 0.08, width: 1 },
  hall: { seconds: 4.2, rt60: 3.4, damping: 0.5, preDelay: 0.03, early: 0.4, bloom: 0.05, width: 0.95 },
  outdoor: { seconds: 2.8, rt60: 2.0, damping: 0.62, preDelay: 0.02, early: 0.25, bloom: 0.02, width: 1 },
  valley: { seconds: 4.5, rt60: 3.6, damping: 0.55, preDelay: 0.09, early: 0.5, bloom: 0.04, width: 1 },
  room: { seconds: 1.4, rt60: 0.9, damping: 0.55, preDelay: 0.008, early: 0.7, bloom: 0.005, width: 0.8 },
  plate: { seconds: 3.2, rt60: 2.6, damping: 0.25, preDelay: 0.01, early: 0.05, bloom: 0.01, width: 1 },
};

export class Mixer {
  constructor(ctx, { quality = 1, destination } = {}) {
    this.ctx = ctx; this.quality = quality;
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const f = (type, freq, q = 0.7) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = freq; n.Q.value = q; return n; };
    const t = ctx.currentTime;
    const ny = this.ny = ctx.sampleRate * 0.45;

    // ---- master chain
    this.pre = g(1);
    this.hp = f('highpass', 24, 0.6);
    this.glue = ctx.createDynamicsCompressor();
    Object.assign(this.glue, {}); this.glue.threshold.value = -20; this.glue.knee.value = 12; this.glue.ratio.value = 2.5; this.glue.attack.value = 0.03; this.glue.release.value = 0.35;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3; this.limiter.knee.value = 0; this.limiter.ratio.value = 20; this.limiter.attack.value = 0.002; this.limiter.release.value = 0.12;
    this.master = g(0.85);
    this.pre.connect(this.hp); this.hp.connect(this.glue); this.glue.connect(this.limiter); this.limiter.connect(this.master);
    this.master.connect(destination || ctx.destination);
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0.6;
    this.master.connect(this.analyser);
    this._abuf = new Float32Array(this.analyser.fftSize);

    // ---- music bus with tape insert
    this.musicIn = g(1); this.musicTrim = g(1);
    this.wow = ctx.createDelay(0.1); this.wow.delayTime.value = 0.015;
    this.wowLfo = ctx.createOscillator(); this.wowLfo.frequency.value = 0.55; this.wowG = g(0);
    this.flutLfo = ctx.createOscillator(); this.flutLfo.frequency.value = 6.8; this.flutG = g(0);
    this.wowLfo.connect(this.wowG); this.wowG.connect(this.wow.delayTime);
    this.flutLfo.connect(this.flutG); this.flutG.connect(this.wow.delayTime);
    this.wowLfo.start(t); this.flutLfo.start(t);
    this.musicLP = f('lowpass', Math.min(18000, ny), 0.5);
    this.shaper = ctx.createWaveShaper(); this.shaper.curve = satCurve(0.6); this.driveIn = g(1); this.driveOut = g(1);
    this.musicDuck = g(1); this.musicVol = g(0.8);
    // gentle mastering tilt: tame boomy lows, add air
    this.eqLow = f('lowshelf', 130, 0.7); this.eqLow.gain.value = -3;
    this.eqHigh = f('highshelf', Math.min(5500, ny * 0.8), 0.7); this.eqHigh.gain.value = 3.5;
    this.musicIn.connect(this.musicTrim); this.musicTrim.connect(this.eqLow); this.eqLow.connect(this.eqHigh); this.eqHigh.connect(this.wow); this.wow.connect(this.musicLP);
    this.musicLP.connect(this.driveIn); this.driveIn.connect(this.shaper); this.shaper.connect(this.driveOut);
    this.driveOut.connect(this.musicDuck); this.musicDuck.connect(this.musicVol); this.musicVol.connect(this.pre);
    this.crackleG = g(0);
    this.crackleG.connect(this.musicLP);

    // ---- ambience / sfx / ui
    this.ambIn = g(1); this.ambLP = f('lowpass', ny, 0.5); this.ambDuck = g(1); this.ambVol = g(0.9);
    this.ambIn.connect(this.ambLP); this.ambLP.connect(this.ambDuck); this.ambDuck.connect(this.ambVol); this.ambVol.connect(this.pre);
    this.sfxIn = g(1); this.sfxLP = f('lowpass', ny, 0.5); this.sfxVol = g(0.9);
    this.sfxIn.connect(this.sfxLP); this.sfxLP.connect(this.sfxVol); this.sfxVol.connect(this.pre);
    this.uiIn = g(1); this.uiVol = g(0.7); this.uiIn.connect(this.uiVol); this.uiVol.connect(this.pre);

    // ---- reverb (A/B convolvers for seamless preset swaps)
    this.reverbIn = g(1);
    this.revPre = f('highpass', 180, 0.5); this.reverbIn.connect(this.revPre);
    this.convA = ctx.createConvolver(); this.convB = ctx.createConvolver();
    this.convA.normalize = false; this.convB.normalize = false;
    this.revGA = g(0); this.revGB = g(0); this.revOut = g(0.55);
    this.revPre.connect(this.convA); this.revPre.connect(this.convB);
    this.convA.connect(this.revGA); this.convB.connect(this.revGB);
    this.revGA.connect(this.revOut); this.revGB.connect(this.revOut);
    this.revOut.connect(this.musicDuck); // reverb tail ducks with the music
    this.activeConv = null; this.reverbName = null;
    this.ambRev = g(1); this.ambRev.connect(this.revPre); // ambience/sfx reverb send entry (pre-muffle not needed)

    // ---- ping-pong echo
    this.echoIn = g(1);
    this.dL = ctx.createDelay(4); this.dR = ctx.createDelay(4);
    this.fbL = g(0.35); this.fbR = g(0.35);
    this.eLP = f('lowpass', 3200, 0.5); this.eHP = f('highpass', 250, 0.5);
    this.echoOut = g(0.5); const mL = ctx.createChannelMerger(2);
    this.echoIn.connect(this.eHP); this.eHP.connect(this.dL);
    this.dL.connect(this.eLP); this.eLP.connect(this.fbL); this.fbL.connect(this.dR); this.dR.connect(this.fbR); this.fbR.connect(this.dL);
    this.dL.connect(mL, 0, 0); this.dR.connect(mL, 0, 1);
    mL.connect(this.echoOut); this.echoOut.connect(this.musicDuck);
    this.echoToRev = g(0.3); this.echoOut.connect(this.echoToRev); this.echoToRev.connect(this.revPre);
    this.merger = mL;

    this.volume = 1; this._muffle = 0;
    this.setEcho(0.5, 0.35, 0.5);
  }

  /** Swap reverb preset (IR regenerated off the audio thread in JS, crossfaded over ~2 s). */
  setReverb(name, t = this.ctx.currentTime, overrides = {}) {
    if (this.reverbName === name && !Object.keys(overrides).length) return;
    const P = { ...(REVERBS[name] || REVERBS.hall), ...overrides };
    const q = clamp(this.quality, 0.4, 1);
    const ir = impulseResponse(this.ctx, { ...P, seconds: P.seconds * (0.55 + 0.45 * q), rt60: P.rt60 * (0.7 + 0.3 * q), seed: name.length * 13 + 5 });
    const useB = this.activeConv === this.convA;
    const conv = useB ? this.convB : this.convA, gIn = useB ? this.revGB : this.revGA, gOut = useB ? this.revGA : this.revGB;
    conv.buffer = ir;
    // wet/dry crossfade between the two convolvers (≈ 3 s): the old space's tail keeps ringing under the new one
    gIn.gain.cancelScheduledValues(t); gIn.gain.setTargetAtTime(1, t, 0.9);
    gOut.gain.cancelScheduledValues(t); gOut.gain.setTargetAtTime(0, t, 1.2);
    this.activeConv = conv; this.reverbName = name; this.reverbSeconds = ir.duration;
  }
  setReverbLevel(v, t = this.ctx.currentTime) { this.revOut.gain.setTargetAtTime(v, t, 1); }

  setEcho(time, fb, mix, t = this.ctx.currentTime) {
    const tt = clamp(time, 0.05, 3.9);
    this.dL.delayTime.setTargetAtTime(tt, t, 0.3); this.dR.delayTime.setTargetAtTime(tt, t, 0.3);
    this.fbL.gain.setTargetAtTime(clamp(fb, 0, 0.8), t, 0.3); this.fbR.gain.setTargetAtTime(clamp(fb, 0, 0.8), t, 0.3);
    this.echoOut.gain.setTargetAtTime(mix, t, 0.5);
    this.echo = { time: tt, fb, mix };
  }

  /** Music-bus colour: tape wow/flutter (seconds of delay modulation), lowpass, drive, vinyl crackle. */
  setInsert({ wow = 0, flutter = 0, lp = 18000, drive = 0, crackle = 0 } = {}, t = this.ctx.currentTime) {
    this.wowG.gain.setTargetAtTime(wow * 0.0035, t, 1);
    this.flutG.gain.setTargetAtTime(flutter * 0.00025, t, 1);
    this._lp = lp = Math.min(lp, this.ny); this.musicLP.frequency.setTargetAtTime(lp * (1 - this._muffle * 0.9), t, 0.8);
    this.shaper.curve = satCurve(0.6 + drive * 3);
    this.driveIn.gain.setTargetAtTime(1 + drive * 1.5, t, 0.5);
    this.driveOut.gain.setTargetAtTime(1 / (1 + drive * 1.2), t, 0.5);
    if (crackle > 0 && !this._crackle) {
      const s = this.ctx.createBufferSource(); s.buffer = sample(this.ctx, 'crackle', 0); s.loop = true; s.start(t); s.connect(this.crackleG); this._crackle = s;
    }
    this.crackleG.gain.setTargetAtTime(crackle * 0.35, t, 1);
    this.insert = { wow, flutter, lp, drive, crackle };
  }

  /** Underwater / muffle amount 0..1 (lowpass on ambience + sfx + music). */
  setMuffle(x, t = this.ctx.currentTime) {
    x = clamp(x, 0, 1); if (Math.abs(x - this._muffle) < 0.01) return;
    this._muffle = x;
    const fc = this.ny * Math.pow(0.02, x);
    this.ambLP.frequency.setTargetAtTime(fc, t, 0.15); this.sfxLP.frequency.setTargetAtTime(fc, t, 0.15);
    this.musicLP.frequency.setTargetAtTime((this._lp || 18000) * Math.pow(0.08, x), t, 0.2);
  }

  /** Sidechain-style duck: depth 0..1, times in seconds. bus: 'music'|'amb'. */
  duck(bus = 'music', depth = 0.5, t = this.ctx.currentTime, attack = 0.08, hold = 1, release = 1.5) {
    const p = (bus === 'amb' ? this.ambDuck : this.musicDuck).gain;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(1 - depth, t, attack / 3);
    p.setTargetAtTime(1, t + attack + hold, release / 3);
  }

  setVolume(v, t = this.ctx.currentTime) { this.volume = clamp(v, 0, 1); this.master.gain.setTargetAtTime(0.85 * this.volume, t, 0.05); }
  setBus(bus, v, t = this.ctx.currentTime, tc = 0.8) { const p = { music: this.musicVol, amb: this.ambVol, sfx: this.sfxVol, ui: this.uiVol }[bus]; p?.gain.setTargetAtTime(v, t, tc); }

  /** RMS / peak dBFS of the master output (post-limiter). */
  levels() {
    try {
      this.analyser.getFloatTimeDomainData(this._abuf);
      let s = 0, pk = 0; for (let i = 0; i < this._abuf.length; i++) { const v = this._abuf[i]; s += v * v; const a = Math.abs(v); if (a > pk) pk = a; }
      const rms = Math.sqrt(s / this._abuf.length);
      return { rmsDb: +(20 * Math.log10(rms + 1e-9)).toFixed(1), peakDb: +(20 * Math.log10(pk + 1e-9)).toFixed(1), gr: +(this.limiter.reduction || 0).toFixed(1), glueGr: +(this.glue.reduction || 0).toFixed(1) };
    } catch (_) { return null; }
  }

  noise(kind) { return noiseBuffer(this.ctx, kind); }
}
