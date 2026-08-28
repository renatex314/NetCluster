import { CellHash } from './cellhash.js';
import { readFeature, featuresOf } from './geojson.js';
import { Schema } from './dimensions.js';

/**
 * NetCluster -- fully dynamic hierarchical geospatial clustering.
 *
 * The index maintains, simultaneously for every zoom level z in [0, maxZoom], a
 * *net* of the live point set at scale r_z = radius / (extent * 2^z) (the same
 * scale supercluster uses, i.e. `radius` screen pixels at zoom z):
 *
 *   (A) NESTING     C_0 subset C_1 subset ... subset C_maxZoom subset P
 *   (B) SEPARATION  distinct c, c' in C_z  =>  d(c, c') > r_z
 *   (C) COVERING    every p in C_{z+1} \ C_z has a parent q in C_z, d(p,q) <= r_z
 *                   (and every leaf has a parent in C_maxZoom)
 *
 * These are exactly the "alpha-good set families" of Schmidt & Sohler (2019),
 * i.e. a compressed net-tree / cover-tree over the Web-Mercator plane. They give
 * the two guarantees the map cares about, at *every* level, at *every* moment:
 *
 *   - cluster radius:  d(p, rep_z(p)) <= sum_{j>=z} r_j <= 2 r_z   (geometric series)
 *   - cluster count:   |C_z| <= |OPT(r_z/2)| , since C_z is r_z-separated no ball
 *                      of radius r_z/2 can hold two of its members
 *
 * so the level-z clustering is a bicriteria (2, 1)-approximation of the optimal
 * radius-r_z clustering, permanently, without any global recomputation.
 *
 * Representation: one node per point ("implicit"/compressed cover tree). A point
 * knows the *coarsest* level at which it is a center (`tz`); it is implicitly a
 * center at every finer level too, which is what removes the O(N log Delta)
 * blowup of materialising every level. LEAF = maxZoom + 1 means "never a center".
 *
 * Each point lives in exactly ONE hash grid -- the one for its own level `tz`,
 * cell size r_tz. A query for "centers of C_z within r_z of q" is answered by
 * sweeping grids 0..z; the work is O(1) per level because coarser grids have
 * proportionally larger cells (they contribute <= 4 probes each) and each cell
 * holds O(1) centers by (B).
 */

const PREC_BITS = 30;
const PREC = 2 ** PREC_BITS;          // fixed-point world units (world = 1.0)
const MAX_CELL_BITS = 24;
const KEY_Y = 2 ** MAX_CELL_BITS;
const KEY_X = 2 ** (MAX_CELL_BITS * 2);

const NONE = -1;
// Cell space reserved per slot in the aggregate key. Slot * CELL_SPAN + cell
// must stay an exact float64 integer, which caps the index at 2^29 slots.
const CELL_SPAN = 1 << 24;

export class NetCluster {
  constructor(options = {}) {
    this.minZoom   = options.minZoom   ?? 0;
    this.maxZoom   = options.maxZoom   ?? 16;
    this.radius    = options.radius    ?? 40;
    this.extent    = options.extent    ?? 512;
    // covering slack: an existing assignment survives until it is violated by
    // this factor. Trades a slightly larger radius bound (2(1+h) r_z) for far
    // fewer visible cluster changes ("recourse") under continuous motion.
    this.hysteresis = options.hysteresis ?? 0.25;

    // Optional filter aggregates. Declaring dimensions up front lets a filtered
    // viewport query ("only status 3", "client 7 and enroute") be answered from
    // precomputed sums instead of walking subtrees. The tree itself is unchanged
    // -- only the aggregate carried at each node gains entries. See
    // `dimensions.js` for what a dimension, a shape and a cell are.
    this.schema = new Schema(options);
    this.categories = options.categories ?? 0;
    this.categoryField = options.categoryField ?? 'category';
    // Where insertFeature/load look for the id when the Feature has no `id`
    // of its own. GeoJSON puts it on the feature; plenty of real files put it
    // in properties instead.
    this.idField = options.idField ?? 'id';

    if (this.maxZoom > 20) throw new Error('maxZoom > 20 exceeds fixed-point cell resolution');

    this.LEAF = this.maxZoom + 1;

    // r[z]: cluster scale at level z, in fixed-point units. r[LEAF] = -1 so that
    // no point can ever be "covered" at the leaf level (terminates the descent).
    this.r  = new Float64Array(this.LEAF + 1);
    this.r2 = new Float64Array(this.LEAF + 1);
    for (let z = 0; z <= this.maxZoom; z++) {
      this.r[z] = PREC * this.radius / (this.extent * 2 ** z);
      this.r2[z] = this.r[z] * this.r[z];
    }
    this.r[this.LEAF] = -1;
    this.r2[this.LEAF] = -1;
    // Grid cell side = 2 r_z. The query ball has diameter 2 r_z, so it spans at
    // most 2 cells per axis: 4 hash probes per level instead of 9. Cells stay
    // dyadic (cs[z] = 2 cs[z+1]) so the shift trick in _gridMove still holds.
    this.cs = new Float64Array(this.LEAF + 1);
    for (let z = 0; z <= this.maxZoom; z++) this.cs[z] = 2 * this.r[z];

    this.hyst2 = new Float64Array(this.LEAF + 1);
    for (let z = 0; z <= this.maxZoom; z++) {
      const rr = this.r[z] * (1 + this.hysteresis);
      this.hyst2[z] = rr * rr;
    }

    this.grid = new CellHash(1024);      // (level, cx, cy) -> head entry
    this.ids  = new Map();               // external id -> slot
    // Slot -> external id lives in a Float64Array (`ext`), which can only hold
    // numbers. Non-numeric ids get this parallel sparse array instead. It stays
    // null until the first one arrives, so an all-numeric index -- and the
    // tie-break on the insertion hot path -- never leaves the typed array.
    this.extStr = null;
    // Reused by the Feature entry points so that reading a Feature allocates
    // nothing: [id, lng, lat, props].
    this._fs = [0, 0, 0, undefined];
    this.eSlot = new Int32Array(1024); this.eNext = new Int32Array(1024);
    this._eCap = 1024; this._eN = 0; this._eFree = NONE;

    // Two representations, one interface.
    //
    // A small cell space is stored DENSELY, `slot * cells + cell`, which is what
    // the 0.2 line did with categories. An array index beats a hash probe by
    // about 2x and existing single-category indexes must not pay for a capability
    // they never asked for, so that layout stays the default wherever it fits.
    //
    // A large one is stored SPARSELY, keyed by (slot, cell) in `agg`, with the
    // payload in parallel arrays and every entry also on its node's doubly-linked
    // list so a subtree's cells can be enumerated when it re-homes. This is the
    // only layout a conjunction fits in: dense charges 20 B per device per cell
    // whether or not the cell occurs, so a cross product of three dimensions runs
    // to terabytes, while sparse holds at most one entry per device per shape per
    // level -- 1.5M entries on a 200k fleet, and flat as dimensions are added.
    //
    // `_find(s, cell)` returns an index into acnt/asx/asy either way, so every
    // reader below is written once.
    this.denseCells = options.denseCells ?? 32;
    this.dense = this.schema.enabled && this.schema.cellCount <= this.denseCells;
    this._C = this.schema.cellCount;
    if (this.schema.enabled && !this.dense) {
      this.agg = new CellHash(1024);
      this._aCap = 1024; this._aN = 0; this._aFree = NONE;
      this.acnt = new Int32Array(this._aCap);
      this.asx = new Float64Array(this._aCap);
      this.asy = new Float64Array(this._aCap);
      this.aCell = new Int32Array(this._aCap);
      this.aNext = new Int32Array(this._aCap);
      this.aPrev = new Int32Array(this._aCap);
    }
    if (this.schema.enabled) {
      // Recomputing a device's cells on every operation would let a caller mutate
      // the props object we stored by reference and silently desynchronise the
      // table, so each device's cells are held here at a fixed stride.
      this._mc = this.schema.maxCellsPerDevice;
      this._cellBuf = new Int32Array(this._mc);
    }

    this._cap = 0;
    this._n = 0;
    this._freeHead = NONE;
    this._grow(1024);

    // scratch candidate buffers (bounded by O(1) packing, 256 is generous)
    this._candA = new Int32Array(256);
    this._candB = new Int32Array(256);
    this._kids  = new Int32Array(1024);

    this.stats = { inserts: 0, removes: 0, moves: 0, movesFast: 0, movesRebuilt: 0,
                   promotions: 0, reparents: 0, probes: 0 };
  }

  // ---------------------------------------------------------------- storage --
  _grow(cap) {
    const old = this._cap;
    this._cap = cap;
    const F = (a) => { const n = new Float64Array(cap); if (a) n.set(a); return n; };
    const I = (a) => { const n = new Int32Array(cap);   if (a) n.set(a); return n; };
    this.qx  = I(this.qx);   this.qy  = I(this.qy);    // fixed-point position
    this.sx  = F(this.sx);   this.sy  = F(this.sy);    // subtree coordinate sums
    this.cnt = I(this.cnt);                            // subtree point count
    this.par = I(this.par);                            // parent slot
    this.kid = I(this.kid);                            // first child
    this.sib = I(this.sib);                            // next sibling
    this.psib = I(this.psib);                          // prev sibling
    this.tz  = I(this.tz);                             // coarsest level as center
    const ext = new Float64Array(cap); if (this.ext) ext.set(this.ext);
    this.ext = ext;                                    // external id
    this.data = this.data || [];                       // user properties
    if (this.schema.enabled) {
      const dc = new Int32Array(cap * this._mc); if (this.dcell) dc.set(this.dcell); this.dcell = dc;
      this.dcellN = I(this.dcellN);                    // how many cells this device has
      if (this.dense) {                                // slot-major: slot*C + cell
        const C = this.schema.cellCount;
        const cc = new Int32Array(cap * C);   if (this.acnt) cc.set(this.acnt); this.acnt = cc;
        const cx = new Float64Array(cap * C); if (this.asx)  cx.set(this.asx);  this.asx  = cx;
        const cy = new Float64Array(cap * C); if (this.asy)  cy.set(this.asy);  this.asy  = cy;
      } else {
        this.cellHead = I(this.cellHead);              // head of this node's entry list
        for (let i = old; i < cap; i++) this.cellHead[i] = NONE;
      }
    }
    for (let i = old; i < cap; i++) { this.par[i] = NONE; this.tz[i] = -2; }
  }

  _alloc() {
    let s;
    if (this._freeHead !== NONE) { s = this._freeHead; this._freeHead = this.par[s]; }
    else {
      if (this._n === this._cap) this._grow(this._cap * 2);
      s = this._n++;
    }
    this.kid[s] = NONE; this.sib[s] = NONE; this.psib[s] = NONE; this.par[s] = NONE;
    // a reused slot cannot inherit stale aggregates: _free cleared them, and
    // _selfMass clears again before writing this device's own mass
    return s;
  }

  /** reset `s` to carry only its own point, in the total and in its own cells */
  _selfMass(s) {
    const x = this.qx[s], y = this.qy[s];
    this.cnt[s] = 1; this.sx[s] = x; this.sy[s] = y;
    if (!this.schema.enabled) return;
    this._dropCells(s);
    const base = s * this._mc, n = this.dcellN[s];
    for (let i = 0; i < n; i++) {
      const e = this._entry(s, this.dcell[base + i]);
      this.acnt[e] = 1; this.asx[e] = x; this.asy[e] = y;
    }
  }

  _free(s) {
    // _unlink left `s` holding its own mass; without this the table keeps a row
    // per removed device forever.
    if (this.schema.enabled) { this._dropCells(s); this.dcellN[s] = 0; }
    this.par[s] = this._freeHead; this._freeHead = s; this.tz[s] = -2;
    this.data[s] = undefined;
    // or the slot's next tenant inherits this one's id
    if (this.extStr !== null) this.extStr[s] = undefined;
  }

  // ------------------------------------------------------------------ grid --
  // One bucket list per (level, cell). A center of C_z is listed in the grid of
  // EVERY level z >= tz, which costs sum_z |C_z| = O(N) entries in practice
  // (measured 3.7-5.4 per point on fleet data, hard cap maxZoom+1) and buys the
  // decisive property: "is any center of C_z within r_z" is ONE 3x3 cell probe,
  // so the placement sweep can run bottom-up and stop at the first hit.

  _growEntries() {
    const cap = this._eCap * 2;
    const eS = new Int32Array(cap); eS.set(this.eSlot); this.eSlot = eS;
    const eN = new Int32Array(cap); eN.set(this.eNext); this.eNext = eN;
    this._eCap = cap;
  }

  _newEntry(s, next) {
    let e;
    if (this._eFree !== NONE) { e = this._eFree; this._eFree = this.eNext[e]; }
    else { if (this._eN === this._eCap) this._growEntries(); e = this._eN++; }
    this.eSlot[e] = s; this.eNext[e] = next;
    return e;
  }

  _key(z, cx, cy) { return z * KEY_X + cx * KEY_Y + cy; }

  /** cell index of slot `s` at the finest level; coarser levels are `>> (maxZoom - z)` */
  _cellX(s) { return Math.floor(this.qx[s] / this.cs[this.maxZoom]); }
  _cellY(s) { return Math.floor(this.qy[s] / this.cs[this.maxZoom]); }

  _gridAddAt(s, z, cx, cy) {
    const k = this._key(z, cx, cy);
    const head = this.grid.get(k);
    this.grid.set(k, this._newEntry(s, head === -1 ? NONE : head));
  }

  _gridDelAt(s, z, cx, cy) {
    const k = this._key(z, cx, cy);
    const head = this.grid.get(k);
    if (head === -1) throw new Error('grid corruption: missing cell');
    if (this.eSlot[head] === s) {
      const nx = this.eNext[head];
      if (nx === NONE) this.grid.delete(k); else this.grid.set(k, nx);
      this.eNext[head] = this._eFree; this._eFree = head;
      return;
    }
    let e = head;
    while (e !== NONE && this.eSlot[this.eNext[e]] !== s) e = this.eNext[e];
    if (e === NONE) throw new Error('grid corruption: slot not in cell');
    const d = this.eNext[e];
    this.eNext[e] = this.eNext[d];
    this.eNext[d] = this._eFree; this._eFree = d;
  }

  /** list `s` in every level from tz[s] down to maxZoom */
  _gridAdd(s) {
    const t = this.tz[s];
    if (t > this.maxZoom) return;
    let cx = this._cellX(s), cy = this._cellY(s);
    for (let z = this.maxZoom; z >= t; z--) { this._gridAddAt(s, z, cx, cy); cx >>= 1; cy >>= 1; }
  }

  _gridDel(s) {
    const t = this.tz[s];
    if (t > this.maxZoom) return;
    let cx = this._cellX(s), cy = this._cellY(s);
    for (let z = this.maxZoom; z >= t; z--) { this._gridDelAt(s, z, cx, cy); cx >>= 1; cy >>= 1; }
  }

  /**
   * Reposition a listed center. Cells are dyadic and aligned, so the level-z
   * cell is the level-(z+1) cell shifted right: once a level's cell is
   * unchanged, every coarser level is unchanged too and the walk stops.
   * A device creeping inside its cell therefore touches no grid at all.
   */
  _gridMove(s, nx, ny) {
    const t = this.tz[s];
    if (t > this.maxZoom) { this.qx[s] = nx; this.qy[s] = ny; return; }
    const cs = this.cs[this.maxZoom];
    let ox = Math.floor(this.qx[s] / cs), oy = Math.floor(this.qy[s] / cs);
    let px = Math.floor(nx / cs), py = Math.floor(ny / cs);
    let z = this.maxZoom;
    while (z >= t && (ox !== px || oy !== py)) {
      this._gridDelAt(s, z, ox, oy);
      this._gridAddAt(s, z, px, py);
      ox >>= 1; oy >>= 1; px >>= 1; py >>= 1; z--;
    }
    this.qx[s] = nx; this.qy[s] = ny;
  }

  /**
   * Append every center of C_z within `rad` of (x,y) into `out`.
   * `rad` <= cell size, so this is a 2x2..3x3 block; each cell holds O(1)
   * centers because C_z is r_z-separated.
   */
  _scan(z, x, y, rad, rad2, out, n, exclude) {
    const cs = this.cs[z];
    const maxc = Math.ceil(PREC / cs);
    let cx0 = Math.floor((x - rad) / cs), cx1 = Math.floor((x + rad) / cs);
    let cy0 = Math.floor((y - rad) / cs), cy1 = Math.floor((y + rad) / cs);
    if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0;
    if (cx1 > maxc) cx1 = maxc; if (cy1 > maxc) cy1 = maxc;
    const { grid, eSlot, eNext, qx, qy } = this;
    for (let cx = cx0; cx <= cx1; cx++) {
      const base = z * KEY_X + cx * KEY_Y;
      for (let cy = cy0; cy <= cy1; cy++) {
        let e = grid.get(base + cy);
        this.stats.probes++;
        if (e === -1) continue;
        do {
          const s = eSlot[e];
          if (s !== exclude) {
            const dx = qx[s] - x, dy = qy[s] - y;
            if (dx * dx + dy * dy <= rad2 && n < out.length) out[n++] = s;
          }
          e = eNext[e];
        } while (e !== NONE);
      }
    }
    return n;
  }

  /**
   * Where does (x, y) belong? Sweep levels from the FINEST upward and stop at
   * the first level whose net already covers the point: that is the finest
   * covering level z*, so the point becomes a center at z*+1 (LEAF when
   * z* === maxZoom) with the nearest C_{z*} member as parent.
   *
   * Sweeping upward is what makes this cheap: it visits only
   * (maxZoom - tz + 2) levels, ~4 on real data, instead of all 17. Sweeping
   * downward would be wrong as well as slower -- "covered at level z" is not
   * monotone in z (finer levels have a smaller radius but a larger center set),
   * so an early stop from the coarse end can leave a point separated from the
   * coarse net while a finer-level center sits inside its exclusion radius.
   */
  _descend(x, y, exclude, from) {
    const cand = this._candA;
    const { qx, qy } = this;
    const top = from === undefined || from > this.maxZoom ? this.maxZoom : from;
    for (let z = top; z >= 0; z--) {
      const n = this._scan(z, x, y, this.r[z], this.r2[z], cand, 0, exclude);
      if (n === 0) continue;
      let bd = Infinity, bs = NONE;
      for (let i = 0; i < n; i++) {
        const s = cand[i];
        const dx = qx[s] - x, dy = qy[s] - y;
        const d2 = dx * dx + dy * dy;
        // exact ties are broken on id so the structure is a function of the
        // point set and op order alone -- never of hash/chain iteration order
        if (d2 < bd || (d2 === bd && String(this._extId(s)) < String(this._extId(bs)))) { bd = d2; bs = s; }
      }
      this._dLevel = z + 1; this._dParent = bs;
      return;
    }
    this._dLevel = 0; this._dParent = NONE;
  }

  /** finest level >= `from` at which some center (other than `exclude`) covers (x,y); -1 if none */
  _coveredAtOrBelow(x, y, from, exclude) {
    const cand = this._candA;
    for (let z = this.maxZoom; z >= from; z--) {
      if (this._scan(z, x, y, this.r[z], this.r2[z], cand, 0, exclude) > 0) return z;
    }
    return -1;
  }

  // ------------------------------------------------------------ aggregates --
  // The table is keyed on (slot, cell). Slots are below 2^29 and cells below
  // 2^24, so the key stays an exact float64 integer and CellHash needs no
  // BigInt -- the same packing trick the grid keys use.
  _aggKey(s, cell) { return s * CELL_SPAN + cell; }

  _growAgg() {
    const cap = this._aCap * 2;
    const I = (a) => { const n = new Int32Array(cap); n.set(a); return n; };
    const F = (a) => { const n = new Float64Array(cap); n.set(a); return n; };
    this.acnt = I(this.acnt); this.asx = F(this.asx); this.asy = F(this.asy);
    this.aCell = I(this.aCell); this.aNext = I(this.aNext); this.aPrev = I(this.aPrev);
    this._aCap = cap;
  }

  /**
   * The hash of `_aggKey(s, cell)`, computed without splitting a float.
   *
   * key = s * 2^24 + cell, so the low half is ((s & 0xFF) << 24) | cell and the
   * high half is s >>> 8 -- exactly what `CellHash.hash` would have derived, but
   * in integer ops. The float modulo it replaces was a real cost on a path taken
   * once per cell per level.
   */
  _aggHash(s, cell) { return CellHash.mix(((s & 0xFF) << 24) | cell, s >>> 8); }

  /** the (s, cell) entry, or -1 when the sparse table has none */
  _find(s, cell) {
    if (this.dense) return s * this._C + cell;
    return this.agg.getH(s * CELL_SPAN + cell, this._aggHash(s, cell));
  }

  /** the (s, cell) entry, created empty and linked onto s's list if absent */
  _entry(s, cell) {
    if (this.dense) return s * this._C + cell;
    const key = s * CELL_SPAN + cell;
    const found = this.agg.getH(key, this._aggHash(s, cell));
    if (found !== -1) return found;
    let e;
    if (this._aFree !== NONE) { e = this._aFree; this._aFree = this.aNext[e]; }
    else { if (this._aN === this._aCap) this._growAgg(); e = this._aN++; }
    this.acnt[e] = 0; this.asx[e] = 0; this.asy[e] = 0; this.aCell[e] = cell;
    const head = this.cellHead[s];
    this.aNext[e] = head; this.aPrev[e] = NONE;
    if (head !== NONE) this.aPrev[head] = e;
    this.cellHead[s] = e;
    this.agg.set(key, e);
    return e;
  }

  /**
   * Release one entry. Entries are freed the moment their count reaches zero
   * rather than left at zero, or an index that churns for months accumulates a
   * row per cell a node ever held -- which is the whole cell space, eventually.
   */
  _release(s, e) {
    const p = this.aPrev[e], n = this.aNext[e];
    if (p === NONE) this.cellHead[s] = n; else this.aNext[p] = n;
    if (n !== NONE) this.aPrev[n] = p;
    this.agg.delete(this._aggKey(s, this.aCell[e]));
    this.aNext[e] = this._aFree; this._aFree = e;
  }

  _dropCells(s) {
    if (this.dense) {
      const C = this._C, b = s * C;
      for (let k = 0; k < C; k++) { this.acnt[b + k] = 0; this.asx[b + k] = 0; this.asy[b + k] = 0; }
      return;
    }
    let e = this.cellHead[s];
    while (e !== NONE) {
      const nx = this.aNext[e];
      this.agg.delete(this._aggKey(s, this.aCell[e]));
      this.aNext[e] = this._aFree; this._aFree = e;
      e = nx;
    }
    this.cellHead[s] = NONE;
  }

  /** add (dc, dx, dy) to one cell of one node, creating or freeing as needed */
  _bump(s, cell, dc, dx, dy) {
    if (this.dense) {
      const i = s * this._C + cell;
      this.acnt[i] += dc; this.asx[i] += dx; this.asy[i] += dy;
      return;
    }
    const e = this._entry(s, cell);
    const c = (this.acnt[e] += dc);
    this.asx[e] += dx; this.asy[e] += dy;
    if (c === 0) this._release(s, e);
  }

  /**
   * Add the mass of ONE device to `from` and every ancestor.
   *
   * This is the hot path. A device touches one cell per declared shape per
   * level, so the work is independent of how many combinations exist -- but it
   * is a hash probe per cell per level rather than an array write, which is what
   * buys conjunctions.
   */
  _agg(from, dc, dx, dy, dev) {
    const { par, cnt, sx, sy } = this;
    if (!this.schema.enabled || dev === undefined) {
      while (from !== NONE) { cnt[from] += dc; sx[from] += dx; sy[from] += dy; from = par[from]; }
      return;
    }
    const base = dev * this._mc, n = this.dcellN[dev], dcell = this.dcell;
    if (this.dense) {
      const { acnt, asx, asy } = this, C = this._C;
      while (from !== NONE) {
        cnt[from] += dc; sx[from] += dx; sy[from] += dy;
        const tb = from * C;
        for (let i = 0; i < n; i++) {
          const j = tb + dcell[base + i];
          acnt[j] += dc; asx[j] += dx; asy[j] += dy;
        }
        from = par[from];
      }
      return;
    }
    while (from !== NONE) {
      cnt[from] += dc; sx[from] += dx; sy[from] += dy;
      for (let i = 0; i < n; i++) this._bump(from, dcell[base + i], dc, dx, dy);
      from = par[from];
    }
  }

  /**
   * Move a whole subtree's mass on or off an ancestor chain. Only re-homing does
   * this, ~3.3 times per removal, so it stays a cold path -- and it now costs
   * the cells that subtree actually holds (at most its point count) rather than
   * every declared combination.
   */
  _aggSub(target, node, sign) {
    const { par, cnt, sx, sy } = this;
    const dc = sign * cnt[node], dx = sign * sx[node], dy = sign * sy[node];
    if (!this.schema.enabled) {
      while (target !== NONE) { cnt[target] += dc; sx[target] += dx; sy[target] += dy; target = par[target]; }
      return;
    }
    if (this.dense) {
      // Skipping empty cells is what keeps this from being the K-shaped cost the
      // dense layout used to pay unconditionally: a subtree holds at most as many
      // cells as it has points.
      const { acnt, asx, asy } = this;
      const C = this._C, nb = node * C;
      while (target !== NONE) {
        cnt[target] += dc; sx[target] += dx; sy[target] += dy;
        const tb = target * C;
        for (let k = 0; k < C; k++) {
          const n = acnt[nb + k];
          if (n === 0) continue;
          acnt[tb + k] += sign * n; asx[tb + k] += sign * asx[nb + k]; asy[tb + k] += sign * asy[nb + k];
        }
        target = par[target];
      }
      return;
    }
    while (target !== NONE) {
      cnt[target] += dc; sx[target] += dx; sy[target] += dy;
      for (let e = this.cellHead[node]; e !== NONE; e = this.aNext[e]) {
        this._bump(target, this.aCell[e], sign * this.acnt[e], sign * this.asx[e], sign * this.asy[e]);
      }
      target = par[target];
    }
  }

  /** Read a device's cells out of `props` into its fixed-stride row. */
  _setCells(s, props, label) {
    const buf = this._cellBuf;
    const n = this.schema.cellsFor(props, buf, label);
    const base = s * this._mc;
    for (let i = 0; i < n; i++) this.dcell[base + i] = buf[i];
    this.dcellN[s] = n;
  }

  /**
   * Re-file a device that is still where it was: take its own mass out of its
   * old cells along the whole ancestor chain, adopt the new ones, put it back.
   * Totals are untouched, because nothing about the point moved.
   */
  _recell(s, buf, n) {
    const base = s * this._mc, old = this.dcellN[s];
    const x = this.qx[s], y = this.qy[s];
    for (let t = s; t !== NONE; t = this.par[t]) {
      for (let i = 0; i < old; i++) this._bump(t, this.dcell[base + i], -1, -x, -y);
    }
    for (let i = 0; i < n; i++) this.dcell[base + i] = buf[i];
    this.dcellN[s] = n;
    for (let t = s; t !== NONE; t = this.par[t]) {
      for (let i = 0; i < n; i++) this._bump(t, this.dcell[base + i], 1, x, y);
    }
  }

  _addChild(p, c) {
    // children are kept sorted by level so viewport queries can stop early
    const { kid, sib, psib, tz } = this;
    this.par[c] = p;
    let prev = NONE, cur = kid[p];
    while (cur !== NONE && tz[cur] < tz[c]) { prev = cur; cur = sib[cur]; }
    sib[c] = cur; psib[c] = prev;
    if (cur !== NONE) psib[cur] = c;
    if (prev === NONE) kid[p] = c; else sib[prev] = c;
  }

  _delChild(c) {
    const { kid, sib, psib, par } = this;
    const p = par[c];
    if (p === NONE) return;
    const nx = sib[c], pv = psib[c];
    if (pv === NONE) kid[p] = nx; else sib[pv] = nx;
    if (nx !== NONE) psib[nx] = pv;
    sib[c] = NONE; psib[c] = NONE; par[c] = NONE;
  }

  // --------------------------------------------------------------- mutation --
  /**
   * Place an already-positioned, already-aggregated slot into the hierarchy.
   * `from` caps the sweep: when re-homing an orphan that did not move, its level
   * can only get coarser (a center covering it at level >= its old level would
   * have violated separation before the deletion), so levels finer than
   * oldLevel-1 cannot produce a hit and are skipped.
   */
  _link(s, from) {
    this._descend(this.qx[s], this.qy[s], s, from);
    const lvl = this._dLevel, p = this._dParent;
    this.tz[s] = lvl;
    this._gridAdd(s);
    if (p !== NONE) {
      this._addChild(p, s);
      this._aggSub(p, s, 1);
    }
  }

  insert(id, lng, lat, props) {
    if (this.ids.has(id)) return this.moveTo(id, lng, lat, props);
    const s = this._alloc();
    const [x, y] = project(lng, lat);
    this.qx[s] = x; this.qy[s] = y;
    if (this.schema.enabled) {
      this.dcellN[s] = 0;                // a reused slot must not inherit cells
      this._setCells(s, props, `device ${JSON.stringify(id)}`);
    }
    this._selfMass(s);
    this.ext[s] = id;                    // NaN for a non-numeric id; see _extId
    if (typeof id !== 'number') {
      if (this.extStr === null) this.extStr = [];
      this.extStr[s] = id;
    }
    if (props !== undefined) this.data[s] = props;
    this.ids.set(id, s);
    this._link(s);
    this.stats.inserts++;
    return s;
  }

  /**
   * The id this slot was inserted under, whatever its type.
   *
   * Without the overlay a string id would come back as the NaN the
   * Float64Array actually stored -- `null` once serialised -- and, worse, every
   * string id would compare equal in the placement tie-break, which is what
   * makes the tree a function of the point set rather than of arrival order.
   */
  _extId(s) {
    if (this.extStr === null) return this.ext[s];
    const v = this.extStr[s];
    return v === undefined ? this.ext[s] : v;
  }

  remove(id) {
    const s = this.ids.get(id);
    if (s === undefined) return false;
    this._unlink(s);
    this.ids.delete(id);
    this._free(s);
    this.stats.removes++;
    return true;
  }

  /** detach `s` from the hierarchy, re-homing its children; `s` keeps its aggregates */
  _unlink(s) {
    const { tz, qx, qy, cnt, sx, sy, kid, sib, par } = this;
    this._gridDel(s);                                    // must vanish before re-homing
    const up = par[s];
    // 1. this point's own mass leaves the ancestor chain
    this._agg(up, -1, -qx[s], -qy[s], s);
    // 2. every child subtree is re-homed elsewhere
    let c = kid[s], k = 0;
    while (c !== NONE) { if (k === this._kids.length) this._kids = grow32(this._kids); this._kids[k++] = c; c = sib[c]; }
    // The list already arrives level-sorted, so only runs of equal level need a
    // canonical order; that is rare, and skipping the check keeps removal
    // allocation-free in the common case.
    let ties = false;
    for (let i = 1; i < k; i++) if (tz[this._kids[i]] === tz[this._kids[i - 1]]) { ties = true; break; }
    if (ties) {
      const K = this._kids, ext = this.ext;
      for (let i = 1; i < k; i++) {                       // insertion sort, in place
        const v = K[i], vz = tz[v];
        let j = i - 1;
        while (j >= 0 && (tz[K[j]] > vz || (tz[K[j]] === vz && String(ext[K[j]]) > String(ext[v])))) {
          K[j + 1] = K[j]; j--;
        }
        K[j + 1] = v;
      }
    }
    for (let i = 0; i < k; i++) {
      const ch = this._kids[i];
      this._aggSub(up, ch, -1);
      this._delChild(ch);
      const oldLevel = tz[ch];
      this._gridDel(ch);
      this._link(ch, oldLevel - 1);
      if (this.tz[ch] < oldLevel) this.stats.promotions++;
      this.stats.reparents++;
    }
    this._delChild(s);
    this.kid[s] = NONE;
    // s now carries exactly its own mass again
    this._selfMass(s);
    this.tz[s] = -2;
  }

  /**
   * Move one point. The fast path only touches the levels whose invariants the
   * displacement actually breaks: a device that moves less than r_maxZoom does
   * O(depth) float adds and O(log Delta) hash probes and nothing else.
   */
  moveTo(id, lng, lat, props) {
    const s = this.ids.get(id);
    if (s === undefined) return this.insert(id, lng, lat, props);
    if (props !== undefined) this.data[s] = props;
    const [x, y] = project(lng, lat);
    const ox = this.qx[s], oy = this.qy[s];
    // A value change is not a move, and must be applied before the unchanged-
    // position shortcut below: a parked vehicle whose status changes has to
    // leave one filter and join another, and it never moves while it does it.
    if (this.schema.enabled && props !== undefined) {
      const buf = this._cellBuf;
      const n = this.schema.cellsFor(props, buf, `device ${JSON.stringify(id)}`);
      const base = s * this._mc;
      let changed = n !== this.dcellN[s];
      if (!changed) {
        for (let i = 0; i < n; i++) if (this.dcell[base + i] !== buf[i]) { changed = true; break; }
      }
      if (changed) this._recell(s, buf, n);
    }
    if (x === ox && y === oy) return s;
    this.stats.moves++;

    const t = this.tz[s];
    let ok = true;

    // (B) separation. p is a member of C_z for EVERY z >= t, so the move is only
    // legal if no center of any such C_z came within r_z. `_descend` computes
    // exactly the finest level at which p is now covered; p may stay put iff
    // that level is coarser than t. Leaves (t === LEAF) carry no separation
    // constraint at all, which is the common case for a dense fleet -- they skip
    // the sweep entirely and cost one distance test.
    if (t <= this.maxZoom && this._coveredAtOrBelow(x, y, t, s) >= 0) ok = false;
    // (C) still covered by our parent (with hysteresis)?
    const p = this.par[s];
    if (ok && p !== NONE) {
      const dx = this.qx[p] - x, dy = this.qy[p] - y;
      ok = dx * dx + dy * dy <= this.hyst2[t - 1];
    }
    // (C) do we still cover our own children?
    if (ok) {
      for (let c = this.kid[s]; c !== NONE; c = this.sib[c]) {
        const dx = this.qx[c] - x, dy = this.qy[c] - y;
        if (dx * dx + dy * dy > this.hyst2[this.tz[c] - 1]) { ok = false; break; }
      }
    }

    if (ok) {
      this._gridMove(s, x, y);
      this._agg(s, 0, x - ox, y - oy, s);
      this.stats.movesFast++;
      return s;
    }

    // slow path: local repair. Detach (children get re-homed), reposition, re-link.
    this._unlink(s);
    this.qx[s] = x; this.qy[s] = y;
    this._selfMass(s);
    this._link(s);
    this.stats.movesRebuilt++;
    return s;
  }

  /**
   * Is a point with this id currently in the index?
   *
   * Cheaper and clearer than `representative(id, z) !== -1`, which was the only
   * way to ask before and conflates "absent" with "at level z".
   */
  has(id) { return this.ids.has(id); }

  get size() { return this.ids.size; }

  // --------------------------------------------------------------- GeoJSON --
  // Interop with the rest of the mapping ecosystem. These are a thin reading
  // layer over insert/moveTo, not a second code path: a Feature is unpacked into
  // the same four values the flat API takes and the wrapper is dropped, so the
  // index that results is byte-for-byte the one you would have built by hand.

  /**
   * Insert one GeoJSON Feature. Moves it instead if the id is already known,
   * exactly like `insert`.
   *
   * The id comes from `feature.id`, where GeoJSON says it belongs, falling back
   * to `properties[idField]`. `properties` is stored as-is -- by reference, as
   * with `insert` -- and the Feature, its geometry and its coordinates array are
   * not retained.
   */
  insertFeature(feature) {
    const f = readFeature(feature, this.idField, this._fs, 'feature');
    return this.insert(f[0], f[1], f[2], f[3]);
  }

  /** Report a new position for one GeoJSON Feature. Inserts if the id is new. */
  moveToFeature(feature) {
    const f = readFeature(feature, this.idField, this._fs, 'feature');
    return this.moveTo(f[0], f[1], f[2], f[3]);
  }

  /**
   * Ingest a FeatureCollection, an array of Features, or a single Feature.
   *
   * @returns how many features were ingested.
   *
   * Two things worth knowing, both deliberate:
   *
   *  - It **upserts** rather than replaces. Loading twice leaves the union, with
   *    the second position winning for any repeated id; it does not throw away
   *    what is already indexed. There is no "reload" here because there is no
   *    rebuild -- that is the whole point of the library.
   *  - It **does not retain the input**. Only the four values it needs are
   *    copied out, so once this returns you can let the parsed GeoJSON go and
   *    the index costs what it would have cost had you called `insert`
   *    directly.
   *
   * Not transactional: a bad feature throws with its index, and the features
   * before it are already in. Pass `{ onError: 'skip' }` to ingest what parses
   * and ignore the rest, which is usually what you want for a file from
   * elsewhere -- compare the return value against the input length to see how
   * much was dropped.
   */
  load(data, options) {
    const [fs, label] = featuresOf(data);
    const skip = options !== undefined && options.onError === 'skip';
    const scratch = this._fs;
    let n = 0;
    for (let i = 0; i < fs.length; i++) {
      if (skip) {
        try { readFeature(fs[i], this.idField, scratch, `${label}[${i}]`); }
        catch { continue; }
      } else {
        readFeature(fs[i], this.idField, scratch, `${label}[${i}]`);
      }
      this.moveTo(scratch[0], scratch[1], scratch[2], scratch[3]);
      n++;
    }
    return n;
  }

  /**
   * The clusters visible in `bbox` at `zoom`, wrapped as a FeatureCollection --
   * the shape `map.getSource(id).setData()` and `L.geoJSON()` want.
   *
   * Identical contents to `getClusters`, which returns the bare array.
   */
  getFeatureCollection(bbox, zoom, category = -1) {
    return { type: 'FeatureCollection', features: this.getClusters(bbox, zoom, category) };
  }

  /**
   * Every live point as a FeatureCollection, unclustered, in insertion order.
   *
   * For export and round-tripping. This materialises one Feature per point, so
   * at half a million points it costs far more than the index does -- it is not
   * a way to draw a map. `getFeatureCollection` is.
   */
  toGeoJSON() {
    const features = [];
    for (const s of this.ids.values()) features.push(this._leafFeature(s));
    return { type: 'FeatureCollection', features };
  }

  // ----------------------------------------------------------------- query --
  /**
   * Aggregate of the cluster represented by center `s` at level `z`.
   * With `cat >= 0` the same subtraction runs over that category's slice, so a
   * filtered cluster costs exactly what an unfiltered one costs.
   */
  _clusterAt(s, z, out, cat, known) {
    if (this.schema.enabled && cat >= 0) {
      const { acnt, asx, asy } = this;
      // The dense index is arithmetic, so it is spelled out here rather than
      // going through _find: this runs once per child of every visited node.
      if (this.dense) {
        const C = this._C;
        let i = s * C + cat;
        let c = acnt[i], ax = asx[i], ay = asy[i];
        for (let b = this.kid[s]; b !== NONE; b = this.sib[b]) {
          if (this.tz[b] > z) break;
          i = b * C + cat;
          c -= acnt[i]; ax -= asx[i]; ay -= asy[i];
        }
        out[0] = c; out[1] = ax; out[2] = ay;
        return out;
      }
      let e = known === undefined ? this._find(s, cat) : known;
      let c = 0, ax = 0, ay = 0;
      if (e !== NONE) { c = acnt[e]; ax = asx[e]; ay = asy[e]; }
      for (let b = this.kid[s]; b !== NONE; b = this.sib[b]) {
        if (this.tz[b] > z) break;
        e = this._find(b, cat);
        if (e !== NONE) { c -= acnt[e]; ax -= asx[e]; ay -= asy[e]; }
      }
      out[0] = c; out[1] = ax; out[2] = ay;
      return out;
    }
    let c = this.cnt[s], ax = this.sx[s], ay = this.sy[s];
    for (let b = this.kid[s]; b !== NONE; b = this.sib[b]) {
      if (this.tz[b] > z) break;                 // sorted by level: rest are inside
      c -= this.cnt[b]; ax -= this.sx[b]; ay -= this.sy[b];
    }
    out[0] = c; out[1] = ax; out[2] = ay;
    return out;
  }

  /** is the device at `s` itself in cell `cell`? */
  _inCell(s, cell) {
    const base = s * this._mc, n = this.dcellN[s];
    for (let i = 0; i < n; i++) if (this.dcell[base + i] === cell) return true;
    return false;
  }

  /** the one member of cell `cat` in cluster (`s`, `z`) -- see getClusters */
  _findSingle(s, z, cat) {
    if (this._inCell(s, cat)) return s;
    for (let b = this.kid[s]; b !== NONE; b = this.sib[b]) {
      if (this.tz[b] <= z) continue;             // already split off at this zoom
      if (this._subtreeCount(b, cat) > 0) return this._findSingleIn(b, cat);
    }
    return s;
  }

  /** same, once the whole subtree is known to be inside the cluster */
  _findSingleIn(s, cat) {
    if (this._inCell(s, cat)) return s;
    for (let b = this.kid[s]; b !== NONE; b = this.sib[b]) {
      if (this._subtreeCount(b, cat) > 0) return this._findSingleIn(b, cat);
    }
    return s;
  }

  /** how many points of cell `cat` sit anywhere under `s` */
  _subtreeCount(s, cat) {
    if (!(this.schema.enabled && cat >= 0)) return this.cnt[s];
    const e = this._find(s, cat);
    return e === NONE ? 0 : this.acnt[e];
  }

  /**
   * All clusters visible in [minLng, minLat, maxLng, maxLat] at `zoom`.
   *
   * Top-down traversal: the roots C_0 are found via the level-0 grid (<= 164
   * cells for the whole world), then we walk down through children whose level
   * is <= z. A subtree rooted at c is pruned when B(c, 2 r_tz[c]) -- which
   * provably contains every descendant of c -- misses the box. The number of
   * visited nodes is therefore O(K) for K clusters returned, independent of N.
   */
  getClusters(bbox, zoom, category = -1) {
    const z = Math.max(this.minZoom, Math.min(this.maxZoom, Math.floor(zoom)));
    const cat = this.schema.enabled ? this.schema.queryCell(category) : -1;
    const dense = this.dense;
    let [x0, y0] = project(bbox[0], bbox[3]);
    let [x1, y1] = project(bbox[2], bbox[1]);
    if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    const out = [];
    const agg = [0, 0, 0];
    const stack = [];
    // roots: every center of C_0 whose subtree ball meets the box
    const cs = this.cs[0], pad0 = 2 * this.r[0];
    const maxc = Math.ceil(PREC / cs);
    const cx0 = Math.max(0, Math.floor((x0 - pad0) / cs)), cx1 = Math.min(maxc, Math.floor((x1 + pad0) / cs));
    const cy0 = Math.max(0, Math.floor((y0 - pad0) / cs)), cy1 = Math.min(maxc, Math.floor((y1 + pad0) / cs));
    for (let cx = cx0; cx <= cx1; cx++) {
      const base = cx * KEY_Y;
      for (let cy = cy0; cy <= cy1; cy++) {
        let e = this.grid.get(base + cy);
        if (e === -1) continue;
        do { stack.push(this.eSlot[e]); e = this.eNext[e]; } while (e !== NONE);
      }
    }
    while (stack.length) {
      const s = stack.pop();
      // a subtree holding none of the requested cell cannot contribute. The
      // entry found here is the one _clusterAt would look up again, so it is
      // passed down rather than probed twice per visited node.
      let se = NONE;
      if (cat >= 0) {
        se = dense ? s * this._C + cat : this._find(s, cat);
        if (se === NONE || this.acnt[se] === 0) continue;
      }
      const pad = 2 * this.r[this.tz[s]];
      const px = this.qx[s], py = this.qy[s];
      if (px < x0 - pad || px > x1 + pad || py < y0 - pad || py > y1 + pad) continue;
      this._clusterAt(s, z, agg, cat, se);
      if (agg[0] > 0) {                     // filtered clusters can be empty
        const mx = agg[1] / agg[0], my = agg[2] / agg[0];
        if (mx >= x0 && mx <= x1 && my >= y0 && my <= y1) {
          // a filtered cluster of one is often a descendant, not the centre
          const one = agg[0] === 1 && cat >= 0 ? this._findSingle(s, z, cat) : s;
          out.push(this._feature(one, z, agg[0], mx, my));
        }
      }
      for (let b = this.kid[s]; b !== NONE; b = this.sib[b]) {
        if (this.tz[b] > z) break;          // sorted: the rest are inside this cluster
        stack.push(b);
      }
    }
    return out;
  }

  /** Vector-tile style query: clusters inside tile (z, x, y), in tile extent coords. */
  getTile(z, x, y) {
    const z2 = 2 ** z;
    const e = this.extent;
    const margin = this.radius / e;
    const bx0 = (x - margin) / z2, bx1 = (x + 1 + margin) / z2;
    const by0 = (y - margin) / z2, by1 = (y + 1 + margin) / z2;
    const feats = this.getClusters([bx0 * 360 - 180, -85.0511, bx1 * 360 - 180, 85.0511], z)
      .filter(f => {
        const [lng, lat] = f.geometry.coordinates;
        const [px, py] = project(lng, lat);
        return py / PREC >= by0 && py / PREC <= by1;
      });
    return feats.length ? { features: feats.map(f => {
      const [lng, lat] = f.geometry.coordinates;
      const [px, py] = project(lng, lat);
      return { type: 1, geometry: [[Math.round((px / PREC * z2 - x) * e), Math.round((py / PREC * z2 - y) * e)]],
               tags: f.properties };
    }) } : null;
  }

  _feature(s, z, count, mx, my) {
    const lng = mx / PREC * 360 - 180;
    const y2 = my / PREC;
    const lat = 360 * Math.atan(Math.exp((0.5 - y2) * 2 * Math.PI)) / Math.PI - 90;
    if (count === 1) {
      const id = this._extId(s);
      return { type: 'Feature',
        properties: this.data[s] !== undefined ? this.data[s] : { id },
        id,
        geometry: { type: 'Point', coordinates: [lng, lat] } };
    }
    return { type: 'Feature',
      properties: { cluster: true, cluster_id: s * 32 + z, point_count: count,
                    point_count_abbreviated: abbrev(count) },
      geometry: { type: 'Point', coordinates: [lng, lat] } };
  }

  /**
   * Decode a cluster id into (slot, level), rejecting anything that is not one.
   * Without this a stray value indexes the typed arrays out of range, yielding
   * `undefined`, which never equals the NONE sentinel -- so the sibling walk
   * spins forever instead of failing.
   */
  _decodeClusterId(clusterId) {
    // Coerce only from number or numeric string. Plain Number() would turn
    // null, false, '' and [] into 0, which looks like a perfectly good cluster id.
    let n = NaN;
    if (typeof clusterId === 'number') n = clusterId;
    else if (typeof clusterId === 'string' && clusterId.trim() !== '') n = Number(clusterId);
    if (!Number.isFinite(n) || n < 0) {
      throw new TypeError(
        `netcluster: ${JSON.stringify(clusterId)} is not a cluster id. Cluster ids are numbers, ` +
        `read from feature.properties.cluster_id on a cluster returned by getClusters(). ` +
        `A device id is not a cluster id -- use representative(deviceId, zoom) to find the cluster a device is in.`);
    }
    const slot = Math.floor(n / 32), z = n % 32;
    if (!Number.isInteger(slot) || slot >= this._n || z > this.maxZoom + 1 || this.tz[slot] === -2) {
      throw new RangeError(`netcluster: cluster id ${clusterId} does not refer to a live cluster`);
    }
    return [slot, z];
  }

  /** The sub-clusters one expansion step below cluster (`s`, `z`). */
  getChildren(clusterId) {
    const [s, z] = this._decodeClusterId(clusterId);
    const nz = this.getClusterExpansionZoom(clusterId);
    const agg = [0, 0, 0];
    if (nz > this.maxZoom) return [this._leafFeature(s)];
    const res = [];
    this._clusterAt(s, nz, agg);
    res.push(this._feature(s, nz, agg[0], agg[1] / agg[0], agg[2] / agg[0]));
    for (let b = this.kid[s]; b !== NONE; b = this.sib[b]) {
      if (this.tz[b] <= z) continue;
      if (this.tz[b] > nz) break;
      this._clusterAt(b, nz, agg);
      res.push(this._feature(b, nz, agg[0], agg[1] / agg[0], agg[2] / agg[0]));
    }
    return res;
  }

  /** Zoom at which cluster (`s`, `z`) first splits. */
  getClusterExpansionZoom(clusterId) {
    const [s, z] = this._decodeClusterId(clusterId);
    for (let b = this.kid[s]; b !== NONE; b = this.sib[b]) {
      if (this.tz[b] > z) return this.tz[b];
    }
    return this.maxZoom + 1;
  }

  getLeaves(clusterId, limit = 10, offset = 0) {
    const [s, z] = this._decodeClusterId(clusterId);
    const out = [];
    let skipped = 0;
    const walk = (n, lvl) => {
      if (out.length >= limit) return;
      if (skipped >= offset) out.push(this._leafFeature(n)); else skipped++;
      for (let b = this.kid[n]; b !== NONE; b = this.sib[b]) {
        if (this.tz[b] <= lvl) continue;
        walk(b, lvl);
        if (out.length >= limit) return;
      }
    };
    walk(s, z);
    return out;
  }

  _leafFeature(s) {
    const lng = this.qx[s] / PREC * 360 - 180;
    const y2 = this.qy[s] / PREC;
    const lat = 360 * Math.atan(Math.exp((0.5 - y2) * 2 * Math.PI)) / Math.PI - 90;
    const id = this._extId(s);
    return { type: 'Feature', id,
      properties: this.data[s] !== undefined ? this.data[s] : { id },
      geometry: { type: 'Point', coordinates: [lng, lat] } };
  }

  /** the level-z representative of a point (its displayed cluster) */
  representative(id, z) {
    let s = this.ids.get(id);
    if (s === undefined) return -1;
    while (this.tz[s] > z) s = this.par[s];
    return s;
  }

  memoryBytes() {
    let filter = 0;
    if (this.schema.enabled) {
      filter = this._cap * (4 + 4 * this._mc);          // each device's cell row
      filter += this.dense
        // 20 B per slot per cell, occupied or not -- that product is exactly why
        // a large cell space goes sparse instead
        ? this._cap * this.schema.cellCount * (4 + 8 + 8)
        // 28 B of payload per entry, plus the directory that finds it
        : this._aCap * (4 + 8 + 8 + 4 + 4 + 4) + this.agg.bytes();
    }
    return this._cap * (2 * 8 + 7 * 4) + this._eCap * 8 + this.grid.bytes() + this.ids.size * 40 +
           (this.extStr === null ? 0 : this.extStr.length * 8) + filter;
  }

  /** live aggregate entries -- what the filter actually costs, see memoryBytes */
  aggEntries() {
    if (!this.schema.enabled) return 0;
    if (this.dense) {
      let n = 0;
      const C = this.schema.cellCount;
      for (const s of this.ids.values()) for (let k = 0; k < C; k++) if (this.acnt[s * C + k] !== 0) n++;
      return n;
    }
    let free = 0;
    for (let e = this._aFree; e !== NONE; e = this.aNext[e]) free++;
    return this._aN - free;
  }

  /** sum_z |C_z| : how many (center, level) pairs the grid holds */
  gridEntries() { let n = 0; for (let e = this._eFree; e !== NONE; e = this.eNext[e]) n++; return this._eN - n; }
}

function grow32(a) { const n = new Int32Array(a.length * 2); n.set(a); return n; }

export function project(lng, lat) {
  let x = (lng + 180) / 360;
  if (x < 0) x = 0; else if (x >= 1) x = 0.9999999;
  const s = Math.sin(lat * Math.PI / 180);
  let y = 0.5 - 0.25 * Math.log((1 + s) / (1 - s)) / Math.PI;
  if (y < 0) y = 0; else if (y >= 1) y = 0.9999999;
  return [Math.round(x * PREC), Math.round(y * PREC)];
}

function abbrev(n) {
  return n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

export { PREC };
