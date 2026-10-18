// Deterministic seeded randomness. The entire universe is a pure function of seeds:
// universe seed -> galaxy seed -> star seed -> planet seed -> feature seeds.
// NEVER use Math.random() for anything that must be reproducible (placement, generation).

// 32-bit integer hash (lowbias32 by Chris Wellons). Good avalanche, fast.
export function hash32(x) {
  x |= 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

// Combine any number of integers/strings into one 32-bit seed.
export function hashCombine(...parts) {
  let h = 0x9e3779b9;
  for (const p of parts) {
    let v;
    if (typeof p === 'string') v = hashString(p);
    else v = (p | 0) ^ Math.floor((p - (p | 0)) * 4294967296);
    h = hash32(h ^ (v + 0x9e3779b9 + (h << 6) + (h >>> 2)));
  }
  return h >>> 0;
}

export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return hash32(h);
}

// Hash to float in [0,1).
export function hashFloat(...parts) {
  return hashCombine(...parts) / 4294967296;
}

// sfc32 PRNG — fast, high quality, 128-bit state.
export class RNG {
  constructor(seed = 1) {
    this.seed = seed >>> 0;
    let a = hash32(seed ^ 0xdeadbeef), b = hash32(seed + 0x1234567), c = hash32(seed * 3 + 0x55aa55aa), d = hash32(seed ^ 0x3c6ef372);
    this.a = a; this.b = b; this.c = c; this.d = d;
    for (let i = 0; i < 12; i++) this.nextU32();
  }
  nextU32() {
    let { a, b, c, d } = this;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    this.a = a; this.b = b; this.c = c; this.d = d;
    return t >>> 0;
  }
  /** float in [0,1) */
  next() { return this.nextU32() / 4294967296; }
  /** float in [min,max) */
  range(min, max) { return min + (max - min) * this.next(); }
  /** integer in [min,max] inclusive */
  int(min, max) { return min + Math.floor(this.next() * (max - min + 1)); }
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  /** weighted pick: items = [[value, weight], ...] */
  weighted(items) {
    let total = 0;
    for (const it of items) total += it[1];
    let r = this.next() * total;
    for (const it of items) { if ((r -= it[1]) <= 0) return it[0]; }
    return items[items.length - 1][0];
  }
  /** standard normal (Box-Muller) */
  gauss(mean = 0, sd = 1) {
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** random unit vector (as [x,y,z]) */
  unitVec(out = [0, 0, 0]) {
    const z = this.range(-1, 1), a = this.range(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
    out[0] = r * Math.cos(a); out[1] = r * Math.sin(a); out[2] = z;
    return out;
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  /** derive an independent child generator */
  fork(tag) { return new RNG(hashCombine(this.seed, typeof tag === 'string' ? hashString(tag) : tag)); }
}
