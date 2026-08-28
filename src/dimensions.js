/**
 * Filter schema: dimensions, query shapes, and the cell encoding that turns a
 * device's values into the integers the aggregate table is keyed on.
 *
 * A *dimension* is a property you filter on (`client`, `status`). A *shape* is a
 * combination you are allowed to query (`['client', 'status']`). A *cell* is one
 * concrete assignment of values to the dimensions of one shape.
 *
 * Shapes are declared rather than inferred because they are what costs memory: a
 * device contributes one aggregate entry per shape per tree level, so declaring
 * `[['client'], ['status'], ['client','status']]` costs three times what
 * `[['client']]` does. Inferring them from queries would make the footprint of an
 * index depend on which page a user happened to open.
 *
 * A query must name exactly the dimensions of some declared shape. That is what
 * keeps a filtered query at one hash probe per node: a partial match over a
 * cross-product would have to sum every cell that agrees on the named dimensions,
 * and the count of those grows with the dimensions you did *not* name.
 */

/** Cells must fit the 24 low bits of the aggregate key; see NetCluster._aggKey. */
export const MAX_CELLS = 1 << 24;

export class Schema {
  constructor(options = {}) {
    const { dimensions, filters, categories, categoryField, maxCellsPerDevice } = options;

    this.dims = [];
    this.byName = new Map();

    if (dimensions !== undefined && dimensions !== null) {
      if (categories) {
        throw new Error('netcluster: pass either `categories` or `dimensions`, not both');
      }
      if (typeof dimensions !== 'object' || Array.isArray(dimensions)) {
        throw new TypeError('netcluster: `dimensions` must be an object of name -> values');
      }
      for (const name of Object.keys(dimensions)) this._addDim(name, dimensions[name]);
    } else if (categories > 0) {
      // The 0.2 spelling. One unnamed dimension of K integer values, queried by
      // a bare number. Kept working exactly, not approximately: these are
      // published packages.
      this._addDim(categoryField ?? 'category', categories);
      this.legacy = true;
    }

    this.enabled = this.dims.length > 0;
    if (!this.enabled) { this.shapes = []; this.cellCount = 0; this.maxCellsPerDevice = 0; return; }

    this.shapes = this._buildShapes(filters);

    // Assign each shape a contiguous block of the cell space, so a cell is
    // `base + mixed-radix index` and decoding is never needed.
    let base = 0;
    for (const sh of this.shapes) {
      sh.base = base;
      let stride = 1;
      sh.strides = new Array(sh.dims.length);
      // last dimension varies fastest, as in a row-major array
      for (let k = sh.dims.length - 1; k >= 0; k--) {
        sh.strides[k] = stride;
        stride *= this.dims[sh.dims[k]].size;
      }
      sh.span = stride;
      base += stride;
    }
    this.cellCount = base;
    if (this.cellCount > MAX_CELLS) {
      throw new Error(
        `netcluster: the declared filters need ${this.cellCount} cells, over the ${MAX_CELLS} limit. ` +
        `A shape costs the product of its dimensions -- drop a shape, or split the index.`);
    }

    // A device holds one cell per shape when every value is single; a multi-valued
    // dimension multiplies. The cap turns "one bad device costs 100x" into an error
    // that names the device, the same stance `max_props_bytes` takes on the server.
    const anyMulti = this.dims.some((d) => d.multi);
    this.maxCellsPerDevice = maxCellsPerDevice ?? (anyMulti ? this.shapes.length * 8 : this.shapes.length);
    if (this.maxCellsPerDevice < this.shapes.length) {
      throw new Error(
        `netcluster: maxCellsPerDevice=${this.maxCellsPerDevice} is below the ${this.shapes.length} ` +
        `declared shapes, so no device could ever be indexed`);
    }

    // Scratch, so that reading a device's values allocates nothing per operation.
    this._vals = this.dims.map(() => []);
    this._n = new Int32Array(this.dims.length);
    // `queryCell` runs once per query and used to allocate an array and a closure
    // getting here; the single-dimension shape is the overwhelmingly common one.
    this._solo = this.shapes.find((s) => s.dims.length === 1 && s.dims[0] === 0);
    this._byKey = new Map(this.shapes.map((s) => [s.key, s]));
  }

  _addDim(name, spec) {
    let values = spec, multi = false;
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
      values = spec.values;
      multi = spec.multi === true;
    }
    let size, names = null;
    if (Array.isArray(values)) {
      size = values.length;
      names = new Map();
      for (let i = 0; i < values.length; i++) names.set(String(values[i]), i);
      if (names.size !== values.length) {
        throw new Error(`netcluster: dimension ${JSON.stringify(name)} has duplicate value labels`);
      }
    } else if (Number.isInteger(values) && values > 0) {
      size = values;
    } else {
      throw new TypeError(
        `netcluster: dimension ${JSON.stringify(name)} must be a count or an array of labels, got ${JSON.stringify(values)}`);
    }
    if (this.byName.has(name)) throw new Error(`netcluster: duplicate dimension ${JSON.stringify(name)}`);
    this.byName.set(name, this.dims.length);
    this.dims.push({ name, size, multi, names });
  }

  _buildShapes(filters) {
    if (filters === undefined || filters === null) {
      // Default: each dimension queryable on its own. Reproduces the single
      // category both in behaviour and in cost.
      return this.dims.map((_, i) => ({ dims: [i], key: String(i) }));
    }
    if (!Array.isArray(filters) || filters.length === 0) {
      throw new TypeError('netcluster: `filters` must be a non-empty array of dimension-name arrays');
    }
    const seen = new Set();
    return filters.map((f) => {
      const list = Array.isArray(f) ? f : [f];
      if (list.length === 0) throw new Error('netcluster: a filter shape must name at least one dimension');
      const idx = list.map((n) => {
        const i = this.byName.get(n);
        if (i === undefined) {
          throw new Error(
            `netcluster: filter shape names ${JSON.stringify(n)}, which is not a declared dimension ` +
            `(have: ${[...this.byName.keys()].join(', ')})`);
        }
        return i;
      });
      // Sorted, so ['a','b'] and ['b','a'] are the same shape rather than two
      // that silently double the memory.
      idx.sort((a, b) => a - b);
      for (let i = 1; i < idx.length; i++) {
        if (idx[i] === idx[i - 1]) {
          throw new Error(`netcluster: filter shape repeats dimension ${JSON.stringify(this.dims[idx[i]].name)}`);
        }
      }
      const key = idx.join(',');
      if (seen.has(key)) throw new Error(`netcluster: duplicate filter shape [${list.join(', ')}]`);
      seen.add(key);
      return { dims: idx, key };
    });
  }

  /** One dimension's value(s) for a device, resolved to indices. */
  _resolve(d, raw, label) {
    const dim = this.dims[d];
    const out = this._vals[d];
    let n = 0;
    if (raw === undefined || raw === null) {
      // Absent means value 0, which is what a missing `category` has always
      // meant. Declare an explicit "unassigned" label if that matters to you.
      out[n++] = 0;
      this._n[d] = n;
      return;
    }
    if (dim.multi && Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i++) out[n++] = this._one(dim, raw[i], label);
      if (n === 0) out[n++] = 0;
    } else {
      if (Array.isArray(raw)) {
        throw new TypeError(
          `netcluster: ${label} gave an array for ${JSON.stringify(dim.name)}, which is not declared \`multi: true\``);
      }
      out[n++] = this._one(dim, raw, label);
    }
    this._n[d] = n;
  }

  _one(dim, v, label) {
    let i;
    if (dim.names !== null) {
      i = dim.names.get(String(v));
      if (i === undefined) {
        if (Number.isInteger(v) && v >= 0 && v < dim.size) return v;   // index also accepted
        throw new Error(
          `netcluster: ${label} has ${JSON.stringify(dim.name)}=${JSON.stringify(v)}, which is not one of ` +
          `${[...dim.names.keys()].map((s) => JSON.stringify(s)).join(', ')}`);
      }
      return i;
    }
    i = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(i) || i < 0 || i >= dim.size) {
      throw new Error(
        `netcluster: ${label} has ${JSON.stringify(dim.name)}=${JSON.stringify(v)}, outside [0, ${dim.size})`);
    }
    return i;
  }

  /**
   * Every cell a device with these properties belongs to, written into `out`.
   * @returns how many were written.
   */
  cellsFor(props, out, label = 'device') {
    for (let d = 0; d < this.dims.length; d++) {
      this._resolve(d, props === undefined || props === null ? undefined : props[this.dims[d].name], label);
    }
    let n = 0;
    for (const sh of this.shapes) n = this._emit(sh, 0, sh.base, out, n, label);
    return n;
  }

  _emit(sh, k, acc, out, n, label) {
    if (k === sh.dims.length) {
      if (n === out.length) {
        throw new Error(
          `netcluster: ${label} lands in more than ${out.length} filter cells. Multi-valued dimensions ` +
          `multiply -- raise \`maxCellsPerDevice\` if that is genuinely intended.`);
      }
      out[n++] = acc;
      return n;
    }
    const d = sh.dims[k], vs = this._vals[d], m = this._n[d], st = sh.strides[k];
    for (let i = 0; i < m; i++) n = this._emit(sh, k + 1, acc + vs[i] * st, out, n, label);
    return n;
  }

  /**
   * The single cell a query selects, or -1 for "everything".
   *
   * The query must name exactly the dimensions of a declared shape; anything else
   * is an error rather than a slow path, so a filter can never quietly become a
   * scan of the whole viewport.
   */
  queryCell(filter) {
    if (filter === undefined || filter === null) return -1;
    if (typeof filter === 'number') {
      if (filter < 0) return -1;                       // the 0.2 "no filter" spelling
      if (this.dims.length !== 1) {
        throw new Error(
          `netcluster: a bare number selects a category, but this index has ${this.dims.length} dimensions. ` +
          `Pass an object, e.g. { ${this.dims[0].name}: ${filter} }.`);
      }
      const sh = this._solo;
      if (sh === undefined) {
        throw new Error(
          `netcluster: no filter shape covers ${JSON.stringify(this.dims[0].name)} on its own, ` +
          `so a bare number cannot select anything`);
      }
      return sh.base + this._one(this.dims[0], filter, 'filter') * sh.strides[0];
    }
    if (typeof filter !== 'object' || Array.isArray(filter)) {
      throw new TypeError(`netcluster: a filter must be an object of dimension -> value, got ${JSON.stringify(filter)}`);
    }
    const names = Object.keys(filter);
    if (names.length === 0) return -1;
    const idx = [];
    for (const n of names) {
      const i = this.byName.get(n);
      if (i === undefined) {
        throw new Error(
          `netcluster: filter names ${JSON.stringify(n)}, which is not a declared dimension ` +
          `(have: ${[...this.byName.keys()].join(', ')})`);
      }
      idx.push(i);
    }
    idx.sort((a, b) => a - b);
    const sh = this._byKey.get(idx.join(','));
    if (sh === undefined) {
      throw new Error(
        `netcluster: no declared filter shape covers [${names.join(', ')}]. ` +
        `Declared: ${this.shapes.map((s) => `[${s.dims.map((d) => this.dims[d].name).join(', ')}]`).join(', ')}. ` +
        `Add it to \`filters\` -- each shape costs one aggregate entry per device per level.`);
    }
    return this._cellOfShape(sh, sh.dims.map((d) => filter[this.dims[d].name]));
  }

  _cellOfShape(sh, raw) {
    let cell = sh.base;
    for (let k = 0; k < sh.dims.length; k++) {
      const dim = this.dims[sh.dims[k]];
      const v = raw[k];
      if (Array.isArray(v)) {
        throw new TypeError(
          `netcluster: filter on ${JSON.stringify(dim.name)} takes one value, not a list. A device may hold ` +
          `several, but a query selects one of them.`);
      }
      cell += this._one(dim, v, 'filter') * sh.strides[k];
    }
    return cell;
  }

  /** For docs and `stats`: what this schema will cost. */
  describe() {
    return {
      dimensions: this.dims.map((d) => ({ name: d.name, values: d.size, multi: d.multi })),
      shapes: this.shapes.map((s) => s.dims.map((d) => this.dims[d].name)),
      cells: this.cellCount,
      maxCellsPerDevice: this.maxCellsPerDevice,
    };
  }
}
