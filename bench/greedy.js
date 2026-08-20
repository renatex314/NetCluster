// Baseline: incremental greedy ("leader") clustering at one zoom, the structure
// most teams end up building when they need incremental updates -- attach each
// point to a nearby cluster centroid, create a new cluster when none is near,
// never revisit past decisions. O(1) per update, no rebuild... and it drifts.
import { project, PREC } from '../src/netcluster.js';

export class GreedyIncremental {
  constructor(zoom, radius = 40, extent = 512) {
    this.r = PREC * radius / (extent * 2 ** zoom);
    this.r2 = this.r * this.r;
    this.cells = new Map();               // cell -> Set(cluster)
    this.clusters = new Map();            // id -> {n, sx, sy, cell}
    this.assign = new Map();              // point -> cluster id
    this.pos = new Map();
    this.next = 1;
  }
  _cell(x, y) { return Math.floor(x / this.r) * 1e7 + Math.floor(y / this.r); }
  _place(c) {
    const k = this._cell(c.sx / c.n, c.sy / c.n);
    if (c.cell === k) return;
    if (c.cell !== undefined) { const b = this.cells.get(c.cell); b.delete(c); if (!b.size) this.cells.delete(c.cell); }
    let b = this.cells.get(k); if (!b) this.cells.set(k, b = new Set());
    b.add(c); c.cell = k;
  }
  _nearest(x, y) {
    const cx = Math.floor(x / this.r), cy = Math.floor(y / this.r);
    let best = null, bd = this.r2;
    for (let ax = -1; ax <= 1; ax++) for (let ay = -1; ay <= 1; ay++) {
      const b = this.cells.get((cx + ax) * 1e7 + (cy + ay)); if (!b) continue;
      for (const c of b) {
        const dx = c.sx / c.n - x, dy = c.sy / c.n - y;
        const d = dx * dx + dy * dy;
        if (d <= bd) { bd = d; best = c; }
      }
    }
    return best;
  }
  insert(id, lng, lat) {
    const [x, y] = project(lng, lat);
    this.pos.set(id, [x, y]);
    let c = this._nearest(x, y);
    if (!c) { c = { id: this.next++, n: 0, sx: 0, sy: 0 }; this.clusters.set(c.id, c); }
    c.n++; c.sx += x; c.sy += y; this._place(c);
    this.assign.set(id, c.id);
  }
  _detach(id) {
    const c = this.clusters.get(this.assign.get(id));
    const [x, y] = this.pos.get(id);
    c.n--; c.sx -= x; c.sy -= y;
    if (c.n === 0) { const b = this.cells.get(c.cell); b.delete(c); if (!b.size) this.cells.delete(c.cell); this.clusters.delete(c.id); }
    else this._place(c);
  }
  moveTo(id, lng, lat) {
    const [x, y] = project(lng, lat);
    const c = this.clusters.get(this.assign.get(id));
    const dx = c.sx / c.n - x, dy = c.sy / c.n - y;
    if (dx * dx + dy * dy <= this.r2) {            // still inside: just shift the centroid
      const [ox, oy] = this.pos.get(id);
      c.sx += x - ox; c.sy += y - oy;
      this.pos.set(id, [x, y]);
      this._place(c);
      return;
    }
    this._detach(id);
    this.insert(id, lng, lat);
  }
  representative(id) { return this.assign.get(id); }
  get clusterCount() { return this.clusters.size; }
}
