// Deterministic names for galaxy clusters in the cosmic web. OWNED BY THE COSMIC TRACK.
const GREAT = [
  'Aurelian', 'Halcyon', 'Meridian', 'Obsidian Crown', 'Thessaly', 'Lantern', 'Cygna', 'Orun',
  'Ember Wells', 'Vesper', 'Anemoi', 'Kairos', 'Solace', 'Ishtar', 'Morrow', 'Calder', 'Amaranth',
  'Tamsin', 'Hollow Choir', 'Verdigris', 'Seraph', 'Nadir', 'Umbriel', 'Loom', 'Tidewell', 'Marrow',
  'Pallas', 'Cinder', 'Evenfall', 'Ostara', 'Lumen', 'Crucible', 'Talas', 'Nereid', 'Wyrd', 'Halo of Iru',
];
const KIND = ['Cluster', 'Cluster', 'Cluster', 'Node', 'Knot', 'Cluster', 'Group'];

function h32(x) {
  x |= 0; x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
  return x >>> 0;
}

/** Names for `count` clusters ranked by mass (rank 0 = most massive). */
export function clusterNames(seed, count) {
  const order = GREAT.map((n, i) => [h32(seed * 7919 + i * 104729), n]).sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (k < 24) {
      const n = order[k % order.length];
      const kind = /Crown|Choir|Wells|Loom|Crucible|Halo/.test(n) ? '' : ' ' + KIND[h32(seed + k * 31) % KIND.length];
      out.push((/^(Loom|Crucible|Hollow|Ember)/.test(n) ? 'The ' : '') + n + kind);
    } else {
      const h = h32(seed ^ (k * 2654435761));
      const ra = h % 2400, dec = ((h >>> 12) % 180) - 90;
      out.push(`RVC J${String(Math.floor(ra / 100)).padStart(2, '0')}${String(ra % 100).padStart(2, '0')}${dec >= 0 ? '+' : '−'}${String(Math.abs(dec)).padStart(2, '0')}`);
    }
  }
  return out;
}
