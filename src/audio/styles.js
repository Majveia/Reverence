// Music styles (AUDIO track). A style is data read by the Composer (music.js):
//   bpm, meter, swing, modes {day, night}, tonic range, progression graph, chord length (bars),
//   chord extensions, reverb / echo / tape insert, breath (probability of resting sections), layers.
// Layer types: pad · drone · arp · melody · bass · comp · perc · grains · bells · counter
//   minE = energy needed for the layer to join a section (energy = flow + danger + discovery),
//   prob = chance the layer plays in a section it qualifies for (contrast between sections).
// Surface styles are picked from body.art.key (ART_STYLE) and refined by a per-art variant.
// Season 2 (creator, 19 Oct): "vibey chillhop/lofi and Ghost of Yotei x Zelda inspired" — the surface base is
// `chillhop`; every style carries the MAIN THEME (theory.js) on a `theme` layer so it returns at every scale.
// Mood flags read by the Composer: nightOnly · nightOff · nightLevel · settledOnly · lift (forced on while
//   gliding) · liftOff · liftOnly · breath (plays in breath sections) · pump (kick sidechain) · penta (sings
//   in the mode's Japanese pentatonic) · theme (can state the theme) · themeOnly (only in theme sections) ·
//   bloom (rises +4 dB in theme sections) · rests (chance to drop a note: BotW phrasing).

export const STYLES = {
  // ------------------------------------------------------------------ scales
  cosmic: {
    trim: 0.37, label: 'Cosmic web — vast evolving pads, the theme on a distant shakuhachi', bpm: [38, 44], meter: 4, swing: 0.5,
    modes: { day: ['lydian', 'ionian', 'lydian', 'dorian'], night: ['lydian', 'dorian'] }, tonic: [38, 40],
    prog: 'lydian', chordBars: [[2, 2], [3, 1]], exts: [['sus2', 3], ['add9', 3], ['quartal', 2], ['triad', 1]],
    reverb: 'cosmos', revLevel: 0.8, echo: { beats: 1.5, fb: 0.45, mix: 0.35 }, insert: {}, breath: 0, modulate: 0.45, themeEvery: 3, themeFirst: 2,
    layers: [
      { id: 'pad', core: true, type: 'pad', timbre: 'warm', voices: 6, range: [45, 79], level: 0.42, glide: 2.8, attack: 3, rev: 0.7 },
      { id: 'halo', type: 'pad', timbre: 'glass', voices: 3, range: [67, 91], level: 0.16, glide: 4, attack: 4, rev: 0.9, echo: 0.2, minE: 0.1, bloom: true },
      { id: 'sub', type: 'drone', timbre: 'drone', notes: [-12, -5], level: 0.17, rev: 0.2 },
      { id: 'grains', type: 'grains', wave: 'glass', range: [74, 103], rate: [2, 14], dur: [0.25, 1.4], level: 0.09, rev: 0.9, echo: 0.3, bloom: true },
      { id: 'bells', type: 'bells', inst: 'celesta', range: [72, 96], prob: 0.12, level: 0.35, rev: 0.9, echo: 0.4, minE: 0.2, bloom: true },
      { id: 'theme', type: 'melody', mono: 'shakuhachi', penta: true, theme: true, themeOnly: true, range: [62, 84], level: 0.52, rev: 0.9, echo: 0.3, pan: 0.18 },
    ],
  },
  galaxy: {
    trim: 0.41, label: 'Galaxy — choir of stars', bpm: [44, 50], meter: 4, swing: 0.5,
    modes: { day: ['aeolian', 'dorian', 'lydian'], night: ['aeolian', 'dorian'] }, tonic: [43, 45],
    prog: 'aeolian', chordBars: [[2, 3], [1, 1]], exts: [['triad', 3], ['add9', 2], ['sus2', 1]],
    reverb: 'cathedral', revLevel: 0.75, echo: { beats: 1.5, fb: 0.35, mix: 0.25 }, insert: {}, breath: 0.05, modulate: 0.3, themeEvery: 3, themeFirst: 2,
    layers: [
      { id: 'choir', core: true, type: 'pad', timbre: 'choir', voices: 5, range: [52, 76], level: 0.4, glide: 1.2, attack: 2.2, rev: 0.8, vowels: ['a', 'o', 'u', 'a', 'e'] },
      { id: 'glass', type: 'grains', wave: 'glass', range: [96, 112], rate: [3, 10], dur: [0.08, 0.5], level: 0.05, rev: 0.9, echo: 0.35, bloom: true },
      { id: 'voice', type: 'melody', mono: 'vox', penta: true, theme: true, themeOnly: true, range: [60, 79], level: 0.4, rev: 0.9, echo: 0.25, pan: -0.12 },
      { id: 'stars', type: 'melody', inst: 'celesta', penta: true, theme: true, themeOnly: true, echoUp: true, range: [72, 96], level: 0.3, rev: 0.9, echo: 0.4, pan: 0.2 },
      { id: 'low', type: 'pad', timbre: 'strings', voices: 2, range: [36, 52], level: 0.3, glide: 1.5, attack: 2.5, rev: 0.5 },
      { id: 'grains', type: 'grains', wave: 'sine', range: [79, 103], rate: [1, 6], dur: [0.15, 0.7], level: 0.06, rev: 0.9, echo: 0.3 },
      { id: 'arp', type: 'arp', inst: 'celesta', range: [67, 91], rate: [1, 2], patterns: ['up', 'updown'], level: 0.22, rev: 0.7, echo: 0.35, minE: 0.3, prob: 0.6 },
      { id: 'harp', type: 'arp', inst: 'harp', range: [55, 79], rate: [2, 2], patterns: ['broken'], level: 0.26, rev: 0.6, minE: 0.5, prob: 0.5 },
    ],
  },
  space: {
    trim: 0.44, label: 'Deep space — drones, distant radio, the theme on bowed glass', bpm: [34, 40], meter: 4, swing: 0.5,
    modes: { day: ['dorian', 'aeolian', 'lydian'], night: ['aeolian', 'phrygian'] }, tonic: [33, 35],
    prog: 'planing', chordBars: [[3, 2], [4, 2]], exts: [['sus2', 2], ['quartal', 2], ['power', 1]],
    reverb: 'cosmos', revLevel: 0.7, echo: { beats: 2, fb: 0.5, mix: 0.3 }, insert: {}, breath: 0.1, modulate: 0.25, themeEvery: 3, themeFirst: 2,
    layers: [
      { id: 'drone', type: 'drone', timbre: 'drone', notes: [0, 7, 12, 19], level: 0.26, rev: 0.4, sweep: true },
      { id: 'pad', type: 'pad', timbre: 'glass', voices: 3, range: [57, 81], level: 0.22, glide: 5, attack: 5, rev: 0.9, echo: 0.2 },
      { id: 'bells', type: 'bells', inst: 'glassBell', range: [60, 88], prob: 0.07, level: 0.3, rev: 0.9, echo: 0.5, bloom: true },
      { id: 'grains', type: 'grains', wave: 'sine', range: [84, 104], rate: [0.5, 3], dur: [0.05, 0.3], level: 0.05, rev: 0.9, echo: 0.4, minE: 0.2, bloom: true },
      { id: 'theme', type: 'melody', mono: 'bowed', penta: true, theme: true, themeOnly: true, range: [64, 86], level: 0.4, rev: 0.95, echo: 0.4 },
      { id: 'cello', type: 'melody', mono: 'cello', range: [45, 64], level: 0.3, density: 0.2, rev: 0.7, minE: 0.45, prob: 0.4 },
    ],
  },

  // ------------------------------------------------------------------ surfaces
  // Season 2 base: chillhop × Ghost of Yotei × Zelda. Rhodes on 7/9/11 close voicings, warm sub, a swung
  // soft kit with a kick-triggered pump, tape wow + vinyl, low-passed "from another room"; koto figures and
  // a shakuhachi singing the mode's Japanese pentatonic; sparse felt piano with rests; distant taiko at vistas.
  chillhop: {
    trim: 0.55, label: 'Chillhop × Yotei — Rhodes, sub, swung kit, koto & shakuhachi', bpm: [72, 86], meter: 4, swing: 0.6,
    modes: { day: ['dorian', 'ionian', 'mixolydian', 'dorian', 'aeolian'], night: ['dorian', 'aeolian', 'phrygian'] }, tonic: [46, 53],
    prog: 'lofi', chordBars: [[1, 3], [2, 2]], exts: [['7', 2], ['9', 3], ['11', 2], ['add9', 1]],
    reverb: 'valley', revLevel: 0.5, echo: { beats: 0.75, fb: 0.3, mix: 0.12 }, insert: { wow: 0.3, flutter: 0.4, lp: 11000, drive: 0.2, crackle: 0.5 }, nightLp: 0.5,
    breath: 0.16, modulate: 0.2, themeEvery: 4, themeFirst: 3,
    layers: [
      { id: 'keys', core: true, type: 'comp', inst: 'rhodes', range: [53, 72], rhythm: 'lofi', level: 0.5, rev: 0.32, echo: 0.06, minE: 0, pump: 1, autopan: [1.7, 0.45] },
      { id: 'bass', core: true, type: 'bass', inst: 'sub', style: 'lofi', range: [33, 47], level: 0.6, rev: 0.04, minE: 0, pump: 1, liftOff: true },
      { id: 'drums', core: true, type: 'perc', kit: 'chill', level: 0.6, rev: 0.12, minE: 0 },
      { id: 'koto', type: 'arp', inst: 'koto', patterns: ['koto'], range: [57, 81], rate: [2, 2], level: 0.42, rev: 0.45, echo: 0.16, minE: 0.1, prob: 0.6, sparse: 0.35, nightLevel: 0.8 },
      { id: 'flute', type: 'melody', mono: 'shakuhachi', penta: true, theme: true, range: [62, 84], level: 0.42, density: 0.3, rev: 0.55, echo: 0.18, minE: 0.3, prob: 0.5, rests: 0.12, lift: true },
      { id: 'piano', type: 'melody', inst: 'felt', penta: true, theme: true, range: [60, 84], level: 0.44, density: 0.32, rev: 0.5, echo: 0.1, minE: 0.06, prob: 0.4, rests: 0.35, breath: true },
      { id: 'kotoTheme', type: 'melody', inst: 'koto', penta: true, theme: true, themeOnly: true, range: [62, 86], level: 0.44, rev: 0.45, echo: 0.15 },
      { id: 'pad', type: 'pad', timbre: 'warm', voices: 4, range: [50, 72], level: 0.15, glide: 0.8, attack: 1.6, rev: 0.6, minE: 0.4, prob: 0.5, pump: 1, nightOff: true, lift: true },
      { id: 'shamisen', type: 'arp', inst: 'shamisen', patterns: ['koto'], range: [50, 70], rate: [2, 2], level: 0.3, rev: 0.25, minE: 0, prob: 0.75, sparse: 0.25, settledOnly: true, core: true },
      { id: 'taiko', type: 'perc', kit: 'taikoSwell', level: 0.5, rev: 0.7, minE: 0.78, prob: 0.6, liftOff: true, nightOff: true },
    ],
  },
  pastoral: {
    trim: 0.72, label: 'Pastoral — piano, harp & strings', bpm: [70, 86], meter: [[4, 3], [3, 1.3]], swing: 0.5,
    modes: { day: ['lydian', 'ionian', 'ionian', 'mixolydian'], night: ['dorian', 'aeolian', 'ionian'] }, tonic: [48, 55],
    prog: 'tonal', chordBars: [[1, 3], [2, 2]], exts: [['triad', 3], ['add9', 2], ['7', 1], ['sus2', 1]],
    reverb: 'valley', revLevel: 0.6, echo: { beats: 0.75, fb: 0.25, mix: 0.12 }, insert: {}, breath: 0.12, modulate: 0.25,
    layers: [
      { id: 'pad', type: 'pad', timbre: 'strings', voices: 4, range: [50, 74], level: 0.26, glide: 0.5, attack: 1.4, rev: 0.6, minE: 0.05, prob: 0.8 },
      { id: 'bass', type: 'bass', inst: 'piano', style: 'root', range: [36, 50], level: 0.4, rev: 0.35, minE: 0.1, prob: 0.85 },
      { id: 'arp', type: 'arp', inst: 'harp', range: [55, 84], rate: [2, 3], patterns: ['broken', 'up', 'updown'], level: 0.34, rev: 0.5, minE: 0.2, prob: 0.8 },
      { id: 'mel', type: 'melody', inst: 'piano', range: [64, 86], level: 0.5, density: 0.5, rev: 0.45, echo: 0.1, minE: 0.3, prob: 0.75 },
      { id: 'counter', type: 'melody', mono: 'flute', range: [67, 88], level: 0.3, density: 0.35, rev: 0.6, minE: 0.6, prob: 0.45, answer: true },
      { id: 'perc', type: 'perc', kit: 'soft', level: 0.35, rev: 0.25, minE: 0.72, prob: 0.8 },
    ],
  },
  hearth: {
    trim: 1.5, label: 'Hearth — banjo, guitar & harmonica by the campfire', bpm: [76, 92], meter: [[4, 3], [3, 1]], swing: 0.54,
    modes: { day: ['mixolydian', 'ionian', 'yo'], night: ['dorian', 'mixolydian'] }, tonic: [45, 52],
    prog: 'mixolydian', chordBars: [[1, 2], [2, 2]], exts: [['triad', 4], ['sus4', 1], ['7', 1]],
    reverb: 'outdoor', revLevel: 0.55, echo: { beats: 0.5, fb: 0.15, mix: 0.05 }, insert: { wow: 0.15, lp: 12000 }, breath: 0.2, modulate: 0.15,
    layers: [
      { id: 'organ', type: 'pad', timbre: 'organ', voices: 3, range: [48, 67], level: 0.13, glide: 0.2, attack: 0.8, rev: 0.5, minE: 0.1, prob: 0.6 },
      { id: 'banjo', core: true, type: 'arp', inst: 'banjo', range: [55, 79], rate: [2, 2], patterns: ['travis'], level: 0.42, rev: 0.35, minE: 0 },
      { id: 'guitar', type: 'comp', inst: 'guitar', range: [48, 67], rhythm: 'strum', level: 0.3, rev: 0.35, minE: 0.3, prob: 0.6 },
      { id: 'bass', type: 'bass', inst: 'guitar', style: 'rootFifth', range: [36, 50], level: 0.38, rev: 0.2, minE: 0.05 },
      { id: 'mel', type: 'melody', mono: 'harmonica', range: [62, 82], level: 0.42, density: 0.35, rev: 0.5, minE: 0.3, prob: 0.6 },
      { id: 'whistle', type: 'melody', mono: 'whistle', range: [70, 90], level: 0.3, density: 0.3, rev: 0.6, minE: 0.5, prob: 0.3, answer: true },
    ],
  },
  desert: {
    trim: 0.85, label: 'Desert — duduk over drones, frame drums', bpm: [84, 98], meter: 4, swing: 0.5,
    modes: { day: ['lydianDom', 'mixolydian', 'hijaz'], night: ['hijaz', 'phrygian', 'aeolian'] }, tonic: [45, 51],
    prog: 'drone', chordBars: [[2, 2], [4, 1]], exts: [['power', 3], ['sus2', 1], ['triad', 1]],
    reverb: 'valley', revLevel: 0.65, echo: { beats: 0.75, fb: 0.3, mix: 0.12 }, insert: { drive: 0.1 }, breath: 0.15, modulate: 0.1,
    layers: [
      { id: 'drone', type: 'drone', timbre: 'organ', notes: [0, 7, 12], level: 0.2, rev: 0.5 },
      { id: 'duduk', core: true, type: 'melody', mono: 'duduk', range: [57, 76], level: 0.6, density: 0.32, rev: 0.6, echo: 0.1, minE: 0.05, ornament: true },
      { id: 'oud', type: 'arp', inst: 'oud', range: [50, 71], rate: [2, 4], patterns: ['drone'], level: 0.34, rev: 0.35, minE: 0.4, prob: 0.6 },
      { id: 'perc', type: 'perc', kit: 'desert', level: 0.45, rev: 0.3, minE: 0.3, prob: 0.85 },
      { id: 'pad', type: 'pad', timbre: 'strings', voices: 3, range: [52, 72], level: 0.14, glide: 1.4, attack: 2, rev: 0.7, minE: 0.5, prob: 0.5 },
    ],
  },
  dune: {
    trim: 0.62, label: 'Arrakeen — throat drones, war drums', bpm: [58, 66], meter: 4, swing: 0.5,
    modes: { day: ['hijaz', 'phrygian', 'aeolian'], night: ['phrygian', 'hijaz'] }, tonic: [36, 41],
    prog: 'drone', chordBars: [[2, 2], [4, 2]], exts: [['power', 3], ['triad', 1]],
    reverb: 'cathedral', revLevel: 0.7, echo: { beats: 1, fb: 0.3, mix: 0.1 }, insert: { drive: 0.35 }, breath: 0.2, modulate: 0.05,
    layers: [
      { id: 'drone', core: true, type: 'drone', timbre: 'brass', notes: [0, 7, 12], level: 0.35, rev: 0.6, sweep: true },
      { id: 'choir', type: 'pad', timbre: 'choir', voices: 3, range: [48, 64], level: 0.26, glide: 2, attack: 3, rev: 0.8, minE: 0.2, vowels: ['o', 'u', 'a'] },
      { id: 'duduk', type: 'melody', mono: 'duduk', range: [52, 70], level: 0.5, density: 0.22, rev: 0.7, minE: 0.1, ornament: true, prob: 0.8 },
      { id: 'perc', type: 'perc', kit: 'taiko', level: 0.55, rev: 0.5, minE: 0.25, prob: 0.8 },
    ],
  },
  vangelis: {
    trim: 0.7, label: 'Neon Monsoon — CS-80 brass, bells in the rain', bpm: [60, 70], meter: 4, swing: 0.5,
    modes: { day: ['aeolian', 'dorian', 'lydian'], night: ['aeolian', 'dorian', 'phrygian'] }, tonic: [43, 50],
    prog: 'aeolian', chordBars: [[2, 3], [1, 1]], exts: [['add9', 2], ['triad', 2], ['sus2', 1], ['7', 1]],
    reverb: 'cathedral', revLevel: 0.85, echo: { beats: 0.75, fb: 0.45, mix: 0.3 }, insert: { drive: 0.1 }, breath: 0.08, modulate: 0.2,
    layers: [
      { id: 'brass', core: true, type: 'pad', timbre: 'brass', voices: 5, range: [48, 74], level: 0.44, glide: 0.35, attack: 1.4, rev: 0.75, echo: 0.1 },
      { id: 'sub', type: 'bass', inst: 'synthBass', style: 'long', range: [31, 43], level: 0.45, rev: 0.15, minE: 0.05 },
      { id: 'bells', type: 'arp', inst: 'bell', range: [67, 91], rate: [2, 2], patterns: ['up', 'random'], level: 0.18, rev: 0.8, echo: 0.55, minE: 0.3, prob: 0.6, sparse: 0.45 },
      { id: 'lead', type: 'melody', mono: 'cs80', range: [60, 84], level: 0.5, density: 0.28, rev: 0.8, echo: 0.35, minE: 0.35, prob: 0.7 },
      { id: 'perc', type: 'perc', kit: 'slowbeat', level: 0.4, rev: 0.6, minE: 0.7, prob: 0.7 },
    ],
  },
  lofi: {
    trim: 0.58, label: 'Bebop — walking bass, brushes, rhodes', bpm: [80, 92], meter: 4, swing: 0.64,
    modes: { day: ['dorian', 'ionian', 'mixolydian'], night: ['dorian', 'aeolian'] }, tonic: [45, 52],
    prog: 'jazz', chordBars: [[1, 4], [2, 1]], exts: [['7', 3], ['9', 2]],
    reverb: 'room', revLevel: 0.45, echo: { beats: 0.5, fb: 0.2, mix: 0.05 }, insert: { wow: 0.35, flutter: 0.5, lp: 7200, drive: 0.25, crackle: 0.6 }, breath: 0.08, modulate: 0.3,
    layers: [
      { id: 'rhodes', core: true, type: 'comp', inst: 'rhodes', range: [52, 72], rhythm: 'charleston', level: 0.5, rev: 0.35, minE: 0 },
      { id: 'bass', core: true, type: 'bass', inst: 'upright', style: 'walk', range: [33, 50], level: 0.62, rev: 0.12, minE: 0 },
      { id: 'drums', type: 'perc', kit: 'brush', level: 0.55, rev: 0.2, minE: 0.06 },
      { id: 'vibes', type: 'melody', inst: 'vibes', range: [65, 86], level: 0.34, density: 0.55, rev: 0.4, minE: 0.35, prob: 0.6, swing: true },
      { id: 'horn', type: 'melody', mono: 'horn', range: [55, 74], level: 0.3, density: 0.3, rev: 0.4, minE: 0.65, prob: 0.4, answer: true },
    ],
  },
  drift: {
    trim: 0.5, label: 'Loop Lowlands — melancholic synths on worn tape', bpm: [72, 84], meter: 4, swing: 0.5,
    modes: { day: ['aeolian', 'dorian', 'ionian'], night: ['aeolian', 'dorian'] }, tonic: [45, 52],
    prog: 'aeolian', chordBars: [[1, 2], [2, 3]], exts: [['add9', 3], ['triad', 2], ['sus2', 2], ['7', 1]],
    reverb: 'hall', revLevel: 0.65, echo: { beats: 0.75, fb: 0.4, mix: 0.25 }, insert: { wow: 0.7, flutter: 0.8, lp: 9000, drive: 0.2, crackle: 0.15 }, breath: 0.12, modulate: 0.2,
    layers: [
      { id: 'pad', core: true, type: 'pad', timbre: 'warm', voices: 4, range: [48, 72], level: 0.46, glide: 0.25, attack: 1.0, rev: 0.6 },
      { id: 'bass', type: 'bass', inst: 'synthBass', style: 'pulse', range: [33, 45], level: 0.38, rev: 0.1, minE: 0.2, prob: 0.8 },
      { id: 'arp', type: 'arp', inst: 'synthPluck', range: [60, 84], rate: [2, 4], patterns: ['updown', 'broken', 'up'], level: 0.3, rev: 0.45, echo: 0.45, minE: 0.3, prob: 0.8 },
      { id: 'lead', type: 'melody', mono: 'lead', range: [62, 81], level: 0.3, density: 0.28, rev: 0.5, echo: 0.4, minE: 0.5, prob: 0.5 },
      { id: 'piano', type: 'melody', inst: 'piano', range: [60, 84], level: 0.3, density: 0.3, rev: 0.6, minE: 0.15, prob: 0.4 },
      { id: 'perc', type: 'perc', kit: 'drift', level: 0.42, rev: 0.4, minE: 0.62, prob: 0.8 },
    ],
  },
  quirky: {
    trim: 0.84, label: 'C-137 Wilds — theremin, bleeps & bouncy bass', bpm: [100, 116], meter: 4, swing: 0.56,
    modes: { day: ['mixolydian', 'lydianDom', 'dorian'], night: ['dorian', 'wholetone'] }, tonic: [45, 52],
    prog: 'mixolydian', chordBars: [[1, 3], [2, 1]], exts: [['triad', 2], ['7', 2], ['sus4', 1], ['6', 1]],
    reverb: 'plate', revLevel: 0.5, echo: { beats: 0.75, fb: 0.35, mix: 0.2 }, insert: { wow: 0.25, drive: 0.15 }, breath: 0.1, modulate: 0.5, mediant: 0.35,
    layers: [
      { id: 'bass', core: true, type: 'bass', inst: 'synthBass', style: 'bounce', range: [33, 50], level: 0.45, rev: 0.1, minE: 0 },
      { id: 'bleeps', type: 'arp', inst: 'kalimba', range: [67, 91], rate: [2, 4], patterns: ['random', 'updown'], level: 0.28, rev: 0.4, echo: 0.4, minE: 0.1, sparse: 0.35 },
      { id: 'theremin', type: 'melody', mono: 'theremin', range: [64, 86], level: 0.4, density: 0.35, rev: 0.6, echo: 0.2, minE: 0.2, prob: 0.8 },
      { id: 'pad', type: 'pad', timbre: 'pulse', voices: 3, range: [55, 72], level: 0.18, glide: 0.15, attack: 0.3, rev: 0.4, minE: 0.3, prob: 0.6 },
      { id: 'perc', type: 'perc', kit: 'toy', level: 0.45, rev: 0.25, minE: 0.35, prob: 0.85 },
    ],
  },
  eerie: {
    trim: 0.66, label: 'The Zone — sparse, eerie, sacred', bpm: [42, 50], meter: 4, swing: 0.5,
    modes: { day: ['aeolian', 'phrygian', 'dorian'], night: ['phrygian', 'in', 'aeolian'] }, tonic: [40, 47],
    prog: 'planing', chordBars: [[2, 2], [3, 1]], exts: [['cluster', 2], ['sus2', 2], ['quartal', 2], ['triad', 1]],
    reverb: 'cathedral', revLevel: 0.85, echo: { beats: 1.5, fb: 0.4, mix: 0.2 }, insert: { wow: 0.1 }, breath: 0.4, modulate: 0.3,
    layers: [
      { id: 'drone', type: 'drone', timbre: 'drone', notes: [-12, 0], level: 0.3, rev: 0.5, sweep: true },
      { id: 'glass', core: true, type: 'pad', timbre: 'glass', voices: 4, range: [55, 79], level: 0.2, glide: 4, attack: 4, rev: 0.9, minE: 0 },
      { id: 'piano', type: 'bells', inst: 'piano', range: [40, 88], prob: 0.1, level: 0.42, rev: 0.9, echo: 0.2, minE: 0.05 },
      { id: 'bowed', type: 'melody', mono: 'bowed', range: [60, 84], level: 0.35, density: 0.15, rev: 0.9, minE: 0.25, prob: 0.5 },
      { id: 'cello', type: 'melody', mono: 'cello', range: [43, 62], level: 0.32, density: 0.18, rev: 0.7, minE: 0.5, prob: 0.4 },
    ],
  },
  sublime: {
    trim: 0.8, label: 'Sublime — romantic strings, choir & horn', bpm: [56, 66], meter: [[4, 2], [3, 1]], swing: 0.5,
    modes: { day: ['aeolian', 'dorian', 'ionian'], night: ['aeolian', 'dorian'] }, tonic: [43, 50],
    prog: 'aeolian', chordBars: [[1, 1], [2, 3]], exts: [['triad', 3], ['add9', 1], ['sus4', 1]],
    reverb: 'cathedral', revLevel: 0.72, echo: { beats: 1, fb: 0.2, mix: 0.08 }, insert: {}, breath: 0.12, modulate: 0.25,
    layers: [
      { id: 'strings', core: true, type: 'pad', timbre: 'strings', voices: 5, range: [43, 74], level: 0.4, glide: 0.6, attack: 1.6, rev: 0.65 },
      { id: 'choir', type: 'pad', timbre: 'choir', voices: 4, range: [55, 74], level: 0.3, glide: 1, attack: 2.4, rev: 0.8, minE: 0.3, prob: 0.6, vowels: ['a', 'o'] },
      { id: 'horn', type: 'melody', mono: 'horn', range: [53, 72], level: 0.45, density: 0.28, rev: 0.7, minE: 0.25, prob: 0.7 },
      { id: 'arp', type: 'arp', inst: 'piano', range: [55, 84], rate: [2, 3], patterns: ['broken', 'up'], level: 0.28, rev: 0.6, minE: 0.45, prob: 0.6 },
      { id: 'bass', type: 'bass', inst: 'harp', style: 'root', range: [31, 45], level: 0.35, rev: 0.4, minE: 0.1 },
      { id: 'timp', type: 'perc', kit: 'timpani', level: 0.35, rev: 0.6, minE: 0.75, prob: 0.6 },
    ],
  },
};

// art preset key → [style, variant overrides]
export const ART_STYLE = {
  ghibli: ['chillhop', { note: 'meadow lofi — koto & shakuhachi' }],
  botw: ['chillhop', { note: 'Hyrule field lofi — sparse felt piano with rests', breath: 0.24, bpm: [70, 80], modes: { day: ['ionian', 'mixolydian', 'dorian'], night: ['dorian', 'aeolian'] },
    layerMod: { piano: { minE: 0, prob: 0.75, rests: 0.42, density: 0.28 }, koto: { prob: 0.45 }, flute: { prob: 0.4 } } }],
  bierstadt: ['chillhop', { note: 'golden-hour lofi — warm pad & shakuhachi', reverb: 'hall', layerMod: { pad: { level: 0.2, minE: 0.15, prob: 0.7 }, flute: { minE: 0.2, prob: 0.6 } } }],
  rogerdean: ['chillhop', { note: 'floating lofi — marimba & glass', modes: { day: ['lydian', 'ionian', 'mixolydian'], night: ['dorian', 'lydian'] },
    layerMod: { pad: { timbre: 'glass', level: 0.18, minE: 0.1 }, koto: { inst: 'marimba' } } }],
  nausicaa: ['chillhop', { note: 'Requiem lofi — shakuhachi & choir', modes: { day: ['aeolian', 'dorian'], night: ['aeolian', 'phrygian'] }, bpm: [70, 78],
    layerMod: { pad: { timbre: 'choir', level: 0.2, minE: 0.1, vowels: ['u', 'o'] }, flute: { minE: 0.12, prob: 0.65 } } }],
  outerwilds: ['hearth', { note: 'campfire banjo' }],
  moebius: ['desert', { note: 'Arzach — duduk & oud' }],
  villeneuve: ['dune', { note: 'Arrakeen throat drones' }],
  bladerunner: ['vangelis', { note: 'Vangelis CS-80' }],
  starfield: ['vangelis', { note: 'frontier horns', modes: { day: ['lydian', 'ionian', 'mixolydian'], night: ['dorian', 'aeolian'] }, prog: 'tonal',
    layerMod: { brass: { timbre: 'strings', level: 0.36 }, bells: { inst: 'piano', rate: [2, 2], patterns: ['broken'] }, lead: { mono: 'horn', range: [53, 74] } } }],
  bebop: ['lofi', { note: 'Tharsis lounge' }],
  stalenhag: ['drift', { note: 'Pacific Drive tape' }],
  nms: ['drift', { note: '65daysofstatic arps', modes: { day: ['lydian', 'ionian', 'dorian'], night: ['dorian', 'aeolian'] }, bpm: [84, 96],
    insert: { wow: 0.25, flutter: 0.3, lp: 12000, drive: 0.15 }, layerMod: { arp: { minE: 0.1, rate: [4, 4] }, perc: { minE: 0.45 } } }],
  rickmorty: ['quirky', { note: 'interdimensional theremin' }],
  tarkovsky: ['eerie', { note: 'Artemiev electronics' }],
  kubrick: ['eerie', { note: 'Ligeti micropolyphony', modes: { day: ['wholetone', 'phrygian'], night: ['wholetone'] }, layerMod: { glass: { timbre: 'choir', voices: 5, level: 0.3, vowels: ['a', 'o', 'u'] }, piano: { prob: 0.03 } } }],
  beksinski: ['eerie', { note: 'cathedral of bones', modes: { day: ['harmonic', 'phrygian'], night: ['phrygian', 'in'] }, layerMod: { glass: { timbre: 'choir', level: 0.2, vowels: ['o', 'u'] } } }],
  crystal: ['eerie', { note: 'the Shimmer', modes: { day: ['lydian', 'wholetone'], night: ['lydian', 'in'] },
    layerMod: { piano: { inst: 'glassBell', prob: 0.16 } }, extraLayers: [{ id: 'shimmer', type: 'grains', wave: 'glass', range: [76, 100], rate: [2, 8], dur: [0.2, 1], level: 0.08, rev: 0.9, echo: 0.3 }] }],
  friedrich: ['sublime', { note: 'Wanderer above the fog' }],
  turner: ['sublime', { note: 'luminous tempest', modes: { day: ['dorian', 'aeolian', 'lydian'], night: ['aeolian'] } }],
};

/** Resolve the concrete style (deep-merged variant) for a scene + art key. */
export function resolveStyle(scene, artKey) {
  let base, variant = {};
  if (scene === 'cosmic' || scene === 'galaxy' || scene === 'space') base = STYLES[scene];
  else {
    const e = ART_STYLE[artKey] || ['chillhop', {}];
    base = STYLES[e[0]]; variant = e[1];
  }
  const st = { ...base, ...variant, key: scene === 'surface' || !STYLES[scene] ? (ART_STYLE[artKey]?.[0] || 'chillhop') : scene, art: artKey || null };
  st.layers = base.layers.map((l) => ({ ...l, ...(variant.layerMod?.[l.id] || {}) }));
  if (variant.extraLayers) st.layers.push(...variant.extraLayers);
  for (const l of st.layers) if (l.mono && variant.layerMod?.[l.id]?.inst) delete l.mono;
  // Zelda rule: every world states the universe's main theme, arranged for its own lead instrument
  if (!st.layers.some((l) => l.theme)) { const lead = st.layers.find((l) => l.type === 'melody'); if (lead) { lead.theme = true; lead.penta = lead.penta ?? false; } }
  if (st.themeEvery == null) st.themeEvery = 4;
  return st;
}
