// Open-addressed hash map from a 53-bit integer cell key to an Int32 value,
// backed by typed arrays. Used as the bucket directory of the per-level grids.
//
// Why not a plain `Map`: we need millions of entries, deterministic memory, and
// ~50M lookups/s. A Map costs ~50-100 bytes/entry and boxes every key.
//
// Keys are exact float64 integers (< 2^53), so `key(z, cx, cy)` can pack a level
// and two 24-bit cell coordinates without BigInt.
//
// Deletion uses backward-shift (Knuth 6.4 alg. R) rather than tombstones, so a
// long-running index that migrates points across cells never accumulates garbage
// -- this matters here: the whole point of the structure is to run forever
// without a rebuild.

const EMPTY = -1;

export class CellHash {
  constructor(initialCapacity = 1024) {
    let cap = 8;
    while (cap < initialCapacity) cap <<= 1;
    this._alloc(cap);
  }

  _alloc(cap) {
    this.cap = cap;
    this.mask = cap - 1;
    this.keys = new Float64Array(cap).fill(EMPTY);
    this.vals = new Int32Array(cap);
    this.size = 0;
    this.limit = (cap * 0.6) | 0;
  }

  /**
   * Mix two 32-bit halves (murmur-ish).
   *
   * Split out so a caller that already holds the halves can skip `hash`'s float
   * modulo -- see NetCluster._aggHash, where the key is built from a slot and a
   * cell whose halves are known by construction. Any such caller must produce
   * exactly what `hash(key)` would, or `_grow` (which rehashes from the stored
   * key) would scatter entries where lookups will not find them.
   */
  static mix(lo, hi) {
    let h = (Math.imul(lo | 0, 0x9e3779b1) ^ Math.imul(hi | 0, 0x85ebca6b)) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0x2545f491) >>> 0;
    h ^= h >>> 13;
    return h >>> 0;
  }

  static hash(key) {
    // split the <=53-bit integer into two 32-bit halves
    const lo = key % 4294967296;
    return CellHash.mix(lo, (key - lo) / 4294967296);
  }

  /** @returns value, or -1 when absent */
  get(key) {
    const { keys, mask } = this;
    let i = CellHash.hash(key) & mask;
    for (;;) {
      const k = keys[i];
      if (k === key) return this.vals[i];
      if (k === EMPTY) return -1;
      i = (i + 1) & mask;
    }
  }

  /** `get`, with the hash already computed by the caller */
  getH(key, h) {
    const { keys, mask } = this;
    let i = h & mask;
    for (;;) {
      const k = keys[i];
      if (k === key) return this.vals[i];
      if (k === EMPTY) return -1;
      i = (i + 1) & mask;
    }
  }

  set(key, val) {
    const { keys, mask } = this;
    let i = CellHash.hash(key) & mask;
    for (;;) {
      const k = keys[i];
      if (k === key) { this.vals[i] = val; return; }
      if (k === EMPTY) {
        keys[i] = key; this.vals[i] = val;
        if (++this.size > this.limit) this._grow();
        return;
      }
      i = (i + 1) & mask;
    }
  }

  delete(key) {
    const { keys, mask } = this;
    let i = CellHash.hash(key) & mask;
    for (;;) {
      const k = keys[i];
      if (k === key) break;
      if (k === EMPTY) return false;
      i = (i + 1) & mask;
    }
    // backward-shift deletion: pull back any entry that probed past slot i
    let j = i;
    for (;;) {
      keys[i] = EMPTY;
      for (;;) {
        j = (j + 1) & mask;
        if (keys[j] === EMPTY) { this.size--; return true; }
        const home = CellHash.hash(keys[j]) & mask;
        // is `home` cyclically outside (i, j]? then entry j may fill hole i
        const a = (j - i) & mask;
        const b = (j - home) & mask;
        if (b >= a) break;
      }
      keys[i] = keys[j];
      this.vals[i] = this.vals[j];
      i = j;
    }
  }

  _grow() {
    const oldKeys = this.keys, oldVals = this.vals, oldCap = this.cap;
    this._alloc(oldCap << 1);
    for (let i = 0; i < oldCap; i++) {
      if (oldKeys[i] !== EMPTY) this.set(oldKeys[i], oldVals[i]);
    }
  }

  bytes() { return this.cap * 12; }
}
