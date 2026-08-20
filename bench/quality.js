import Supercluster from 'supercluster';
import { NetCluster, project, PREC } from '../src/netcluster.js';
import { makeFleet, geojson, table, fmt } from './common.js';

const N = 50_000;
const RADIUS = 40, MAXZOOM = 16;
const ZOOMS = [4, 6, 8, 10, 12, 14];
const WORLD = [-180, -85, 180, 85];

const pts = makeFleet(N, 1);
const qx = new Float64Array(N), qy = new Float64Array(N);
for (let i = 0; i < N; i++) { const [a, b] = project(pts[i * 2], pts[i * 2 + 1]); qx[i] = a; qy[i] = b; }

// nearest-neighbour of every point (grid-accelerated), used for the "split
// neighbours" artefact metric
function nearestNeighbours() {
  const cell = 8 * PREC * RADIUS / (512 * 2 ** MAXZOOM);
  const buckets = new Map();
  for (let i = 0; i < N; i++) {
    const k = Math.floor(qx[i] / cell) * 1e7 + Math.floor(qy[i] / cell);
    let b = buckets.get(k); if (!b) buckets.set(k, b = []); b.push(i);
  }
  const nn = new Int32Array(N), nd = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const cx = Math.floor(qx[i] / cell), cy = Math.floor(qy[i] / cell);
    let best = -1, bd = Infinity;
    for (let ax = -1; ax <= 1; ax++) for (let ay = -1; ay <= 1; ay++) {
      const b = buckets.get((cx + ax) * 1e7 + (cy + ay)); if (!b) continue;
      for (const j of b) {
        if (j === i) continue;
        const dx = qx[j] - qx[i], dy = qy[j] - qy[i];
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = j; }
      }
    }
    nn[i] = best; nd[i] = Math.sqrt(bd);
  }
  return { nn, nd };
}
const { nn, nd } = nearestNeighbours();

/** metrics for an assignment: point -> cluster key, plus cluster centroids */
function measure(assign, centro, z) {
  const rz = PREC * RADIUS / (512 * 2 ** z);
  const toPx = (d) => d / rz * RADIUS;
  const clusters = new Map();
  for (let i = 0; i < N; i++) {
    const k = assign[i];
    let c = clusters.get(k); if (!c) clusters.set(k, c = { n: 0, x: 0, y: 0 });
    c.n++; c.x += qx[i]; c.y += qy[i];
  }
  for (const c of clusters.values()) { c.cx = c.x / c.n; c.cy = c.y / c.n; }
  if (centro) for (const [k, v] of centro) { const c = clusters.get(k); if (c) { c.cx = v[0]; c.cy = v[1]; } }
  const ds = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const c = clusters.get(assign[i]);
    ds[i] = Math.hypot(qx[i] - c.cx, qy[i] - c.cy);
  }
  const sorted = Float64Array.from(ds).sort();
  // split neighbours: mutually adjacent points (< 0.25 r_z apart) torn apart
  let close = 0, split = 0;
  for (let i = 0; i < N; i++) {
    if (nd[i] > 0.25 * rz) continue;
    close++;
    if (assign[i] !== assign[nn[i]]) split++;
  }
  // closest pair of displayed centroids (visual collision)
  const cs = [...clusters.values()];
  let minSep = Infinity;
  const cellSize = rz;
  const grid = new Map();
  for (const c of cs) {
    const k = Math.floor(c.cx / cellSize) * 1e7 + Math.floor(c.cy / cellSize);
    let b = grid.get(k); if (!b) grid.set(k, b = []); b.push(c);
  }
  for (const c of cs) {
    const gx = Math.floor(c.cx / cellSize), gy = Math.floor(c.cy / cellSize);
    for (let ax = -1; ax <= 1; ax++) for (let ay = -1; ay <= 1; ay++) {
      const b = grid.get((gx + ax) * 1e7 + (gy + ay)); if (!b) continue;
      for (const o of b) { if (o === c) continue; const d = Math.hypot(c.cx - o.cx, c.cy - o.cy); if (d < minSep) minSep = d; }
    }
  }
  return {
    clusters: clusters.size,
    meanPx: toPx(ds.reduce((a, b) => a + b, 0) / N),
    p95Px: toPx(sorted[Math.floor(N * 0.95)]),
    maxPx: toPx(sorted[N - 1]),
    splitPct: close ? 100 * split / close : 0,
    minSepPx: isFinite(minSep) ? toPx(minSep) : Infinity,
  };
}

// ---- build the three indexes -------------------------------------------------
const nc = new NetCluster({ radius: RADIUS, maxZoom: MAXZOOM });
for (let i = 0; i < N; i++) nc.insert(i, pts[i * 2], pts[i * 2 + 1]);
const sc = new Supercluster({ radius: RADIUS, maxZoom: MAXZOOM, minZoom: 0 });
sc.load(geojson(pts));

const rows = [];
for (const z of ZOOMS) {
  const rz = PREC * RADIUS / (512 * 2 ** z);

  // netcluster
  const aN = new Int32Array(N);
  for (let i = 0; i < N; i++) aN[i] = nc.representative(i, z);
  const cN = new Map();
  for (const f of nc.getClusters(WORLD, z)) {
    const id = f.properties.cluster_id;
    const [a, b] = project(f.geometry.coordinates[0], f.geometry.coordinates[1]);
    if (id !== undefined) cN.set(Math.floor(id / 32), [a, b]);
  }

  // supercluster: recover the assignment through getLeaves
  const aS = new Int32Array(N).fill(-1);
  const cS = new Map();
  let cid = 0;
  for (const f of sc.getClusters(WORLD, z)) {
    const key = cid++;
    const [a, b] = project(f.geometry.coordinates[0], f.geometry.coordinates[1]);
    cS.set(key, [a, b]);
    if (f.properties.cluster) {
      for (const leaf of sc.getLeaves(f.properties.cluster_id, Infinity)) aS[leaf.properties.id] = key;
    } else aS[f.properties.id] = key;
  }
  for (let i = 0; i < N; i++) if (aS[i] < 0) throw new Error('supercluster left point ' + i + ' unassigned at z=' + z);

  // fixed grid (the "O(1) per update but grid-aligned" baseline)
  const aG = new Int32Array(N);
  for (let i = 0; i < N; i++) aG[i] = Math.floor(qx[i] / rz) * 1e7 + Math.floor(qy[i] / rz);

  for (const [name, a, c] of [['netcluster', aN, cN], ['supercluster', aS, cS], ['fixed grid', aG, null]]) {
    const m = measure(a, c, z);
    rows.push({ zoom: z, method: name, clusters: fmt(m.clusters, 0),
                'mean px': fmt(m.meanPx), 'p95 px': fmt(m.p95Px), 'max px': fmt(m.maxPx),
                'split nbrs %': fmt(m.splitPct, 1), 'min centroid gap px': fmt(m.minSepPx, 1) });
  }
}
console.log('\n=== CLUSTER QUALITY (N=' + fmt(N, 0) + ', radius=40px) ===');
console.log('  mean/p95/max px : distance from a point to the centroid it is drawn as');
console.log('  split nbrs %    : pairs closer than 10px placed in different clusters');
console.log('  min centroid gap: closest pair of drawn cluster markers\n');
table(rows);
