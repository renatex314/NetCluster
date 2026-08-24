import { CellHash } from './cellhash.js';
import { readFeature, featuresOf } from './geojson.js';

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

    // Optional per-category aggregates. Declaring K categories up front lets a
    // filtered viewport query ("only status 3") be answered from precomputed
    // sums instead of walking subtrees. The tree itself is unchanged -- only the
    // aggregate carried at each node gains K slices -- so a point still touches
    // exactly one slice per level and the update cost does NOT grow with K.
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
    const K = this.categories;
    if (K > 0) {                                       // slot-major: slot*K + k
      this.cat = I(this.cat);
      const cc = new Int32Array(cap * K);   if (this.ccnt) cc.set(this.ccnt);  this.ccnt = cc;
      const cx = new Float64Array(cap * K); if (this.csx)  cx.set(this.csx);   this.csx  = cx;
      const cy = new Float64Array(cap * K); if (this.csy)  cy.set(this.csy);   this.csy  = cy;
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
    const K = this.categories;
    if (K > 0) {                                       // a reused slot must not
      const b = s * K;                                 // inherit stale slices
      for (let k = 0; k < K; k++) { this.ccnt[b + k] = 0; this.csx[b + k] = 0; this.csy[b + k] = 0; }
    }
    return s;
  }

  /** reset `s` to carry only its own point, in the total and in its slice */
  _selfMass(s) {
    const x = this.qx[s], y = this.qy[s];
    this.cnt[s] = 1; this.sx[s] = x; this.sy[s] = y;
    const K = this.categories;
    if (K > 0) {
      const b = s * K;
      for (let k = 0; k < K; k++) { this.ccnt[b + k] = 0; this.csx[b + k] = 0; this.csy[b + k] = 0; }
      const c = this.cat[s];
      this.ccnt[b + c] = 1; this.csx[b + c] = x; this.csy[b + c] = y;
    }
  }

  _free(s) {
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
  /**
   * Add the mass of ONE point to `s` and every ancestor. This is the hot path:
   * a point belongs to a single category, so it touches a single slice and the
   * work is independent of how many categories exist.
   */
  _agg(s, dc, dx, dy, k) {
    const { par, cnt, sx, sy } = this;
    const K = this.categories;
    if (K > 0 && k !== undefined) {
      const { ccnt, csx, csy } = this;
      while (s !== NONE) {
        cnt[s] += dc; sx[s] += dx; sy[s] += dy;
        const b = s * K + k;
        ccnt[b] += dc; csx[b] += dx; csy[b] += dy;
        s = par[s];
      }
      return;
    }
    while (s !== NONE) { cnt[s] += dc; sx[s] += dx; sy[s] += dy; s = par[s]; }
  }

  /**
   * Move a whole subtree's mass (all K slices) on or off an ancestor chain.
   * Only re-homing does this, ~3.3 times per removal, so the K factor lands on
   * the cold path.
   */
  _aggSub(target, node, sign) {
    const { par, cnt, sx, sy } = this;
    const K = this.categories;
    const dc = sign * cnt[node], dx = sign * sx[node], dy = sign * sy[node];
    if (K === 0) {
      while (target !== NONE) { cnt[target] += dc; sx[target] += dx; sy[target] += dy; target = par[target]; }
      return;
    }
    const { ccnt, csx, csy } = this;
    const nb = node * K;
    while (target !== NONE) {
      cnt[target] += dc; sx[target] += dx; sy[target] += dy;
      const tb = target * K;
      for (let k = 0; k < K; k++) {
        ccnt[tb + k] += sign * ccnt[nb + k];
        csx[tb + k] += sign * csx[nb + k];
        csy[tb + k] += sign * csy[nb + k];
      }
      target = par[target];
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
    if (this.categories > 0) {
      const c = props ? (props[this.categoryField] | 0) : 0;
      if (c < 0 || c >= this.categories) {
        throw new Error(`netcluster: ${this.categoryField}=${c} outside [0, ${this.categories})`);
      }
      this.cat[s] = c;
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
    this._agg(up, -1, -qx[s], -qy[s], this.categories > 0 ? this.cat[s] : undefined);
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
      this._agg(s, 0, x - ox, y - oy, this.categories > 0 ? this.cat[s] : undefined);
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
   * Two things differ from supercluster's `load`, both deliberately:
   *
   *  - It **upserts** rather than replaces. Loading twice leaves the union, with
   *    the second position winning for any repeated id; it does not throw away
   *    what is already indexed. There is no "reload" here because there is no
   *    rebuild -- that is the whole point of the library.
   *  - It **does not retain the input**. supercluster keeps the array forever,
   *    because its queries hand your original Feature objects back. NetCluster
   *    copies out the four values it needs, so once this returns you can let the
   *    parsed GeoJSON go and the index costs what it would have cost had you
   *    called `insert` directly.
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
  _clusterAt(s, z, out, cat) {
    const K = this.categories;
    if (K > 0 && cat >= 0) {
      const { ccnt, csx, csy } = this;
      let i = s * K + cat;
      let c = ccnt[i], ax = csx[i], ay = csy[i];
      for (let b = this.kid[s]; b !== NONE; b = this.sib[b]) {
        if (this.tz[b] > z) break;
        i = b * K + cat;
        c -= ccnt[i]; ax -= csx[i]; ay -= csy[i];
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

  /** the one member of category `cat` in cluster (`s`, `z`) -- see getClusters */
  _findSingle(s, z, cat) {
    if (this.cat[s] === cat) return s;
    for (let b = this.kid[s]; b !== NONE; b = this.sib[b]) {
      if (this.tz[b] <= z) continue;             // already split off at this zoom
      if (this._subtreeCount(b, cat) > 0) return this._findSingleIn(b, cat);
    }
    return s;
  }

  /** same, once the whole subtree is known to be inside the cluster */
  _findSingleIn(s, cat) {
    if (this.cat[s] === cat) return s;
    for (let b = this.kid[s]; b !== NONE; b = this.sib[b]) {
      if (this._subtreeCount(b, cat) > 0) return this._findSingleIn(b, cat);
    }
    return s;
  }

  /** how many points of `cat` sit anywhere under `s` */
  _subtreeCount(s, cat) {
    return this.categories > 0 && cat >= 0 ? this.ccnt[s * this.categories + cat] : this.cnt[s];
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
    const cat = this.categories > 0 ? category : -1;
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
      // a subtree holding none of the requested category cannot contribute
      if (cat >= 0 && this._subtreeCount(s, cat) === 0) continue;
      const pad = 2 * this.r[this.tz[s]];
      const px = this.qx[s], py = this.qy[s];
      if (px < x0 - pad || px > x1 + pad || py < y0 - pad || py > y1 + pad) continue;
      this._clusterAt(s, z, agg, cat);
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
    return this._cap * (2 * 8 + 7 * 4) + this._eCap * 8 + this.grid.bytes() + this.ids.size * 40 +
           (this.extStr === null ? 0 : this.extStr.length * 8);
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
