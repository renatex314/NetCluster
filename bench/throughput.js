import Supercluster from 'supercluster';
import { NetCluster } from '../src/netcluster.js';
import { makeFleet, makeMotion, step, geojson, table, fmt } from './common.js';

const SIZES = [10_000, 100_000, 1_000_000];
const VIEWPORT = [-46.9, -23.75, -46.4, -23.35];      // Sao Paulo metro, ~1 screen

console.log('\n=== THROUGHPUT: cost of reflecting device movement ===\n');
const rows = [];
const qrows = [];

for (const N of SIZES) {
  const pts = makeFleet(N, 1);
  const feats = geojson(pts);

  // --- supercluster: the only way to reflect a moved point is a full reload
  const sc = new Supercluster({ radius: 40, maxZoom: 16, minZoom: 0 });
  let t0 = process.hrtime.bigint();
  sc.load(feats);
  let t1 = process.hrtime.bigint();
  const scLoad = Number(t1 - t0) / 1e6;

  // --- netcluster: build by streaming inserts
  const nc = new NetCluster({ radius: 40, maxZoom: 16 });
  t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) nc.insert(i, pts[i * 2], pts[i * 2 + 1]);
  t1 = process.hrtime.bigint();
  const ncBuild = Number(t1 - t0) / 1e6;

  // --- moves: one tick of the whole fleet, device by device
  const mo = makeMotion(N, 2, 12);
  const MOVES = Math.min(N, 200_000);
  for (let i = 0; i < MOVES; i++) { const [x, y] = step(pts, mo, i); nc.moveTo(i, x, y); }  // warm
  const before = { ...nc.stats };
  t0 = process.hrtime.bigint();
  for (let i = 0; i < MOVES; i++) { const [x, y] = step(pts, mo, i); nc.moveTo(i, x, y); }
  t1 = process.hrtime.bigint();
  const moveUs = Number(t1 - t0) / 1000 / MOVES;
  const fastPct = 100 * (nc.stats.movesFast - before.movesFast) / (nc.stats.moves - before.moves);
  const probes = (nc.stats.probes - before.probes) / MOVES;

  rows.push({
    N: fmt(N, 0),
    'supercluster rebuild (ms)': fmt(scLoad),
    'netcluster build (ms)': fmt(ncBuild),
    'netcluster move (us)': fmt(moveUs, 2),
    'moves/s': fmt(1e6 / moveUs, 0),
    'fast path %': fmt(fastPct, 0),
    'probes/move': fmt(probes, 1),
    'speedup vs rebuild': fmt(scLoad * 1000 / moveUs, 0) + 'x',
  });

  // --- viewport queries
  for (const z of [6, 10, 14]) {
    const R = 200;
    t0 = process.hrtime.bigint();
    let a = 0; for (let i = 0; i < R; i++) a += sc.getClusters(VIEWPORT, z).length;
    t1 = process.hrtime.bigint();
    const scQ = Number(t1 - t0) / 1e6 / R;
    t0 = process.hrtime.bigint();
    let b = 0; for (let i = 0; i < R; i++) b += nc.getClusters(VIEWPORT, z).length;
    t1 = process.hrtime.bigint();
    const ncQ = Number(t1 - t0) / 1e6 / R;
    qrows.push({ N: fmt(N, 0), zoom: z, 'sc clusters': a / R, 'nc clusters': b / R,
                 'sc query (ms)': fmt(scQ, 3), 'nc query (ms)': fmt(ncQ, 3) });
  }
  global.gc?.();
}

table(rows);
console.log('\n=== VIEWPORT QUERY (Sao Paulo metro, ~1 screen) ===\n');
table(qrows);
