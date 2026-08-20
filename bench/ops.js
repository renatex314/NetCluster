// Per-operation cost and memory, side by side with supercluster.
// Reports the median of several trials: a laptop varies ~10% run to run, so a
// single sample would over-state the precision.
import Supercluster from 'supercluster';
import { NetCluster } from '../src/netcluster.js';
import { makeFleet, makeMotion, step, geojson, table, fmt } from './common.js';

const N = 500_000;
const TRIALS = Number(process.env.TRIALS || 3);
const mem = () => { global.gc?.(); const m = process.memoryUsage(); return m.heapUsed + m.external; };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const us = (t0, n) => Number(process.hrtime.bigint() - t0) / 1000 / n;

const samples = { insert: [], move: [], remove: [], reinsert: [] };
let last = null;

// Memory first, on a clean heap: measured across the timing trials it would be
// dominated by churn from earlier trials rather than by the index itself.
const memPts = makeFleet(N, 1);
const mA = mem();
const memNc = new NetCluster({ radius: 40, maxZoom: 16 });
for (let i = 0; i < N; i++) memNc.insert(i, memPts[i * 2], memPts[i * 2 + 1]);
const ncBytes = mem() - mA;
const ncSelf = memNc.memoryBytes();
const entriesPerPoint = memNc.gridEntries() / memNc.size;
const mB = mem();
const memSc = new Supercluster({ radius: 40, maxZoom: 16, minZoom: 0 });
memSc.load(geojson(memPts));
const scBytes = mem() - mB;

for (let trial = 0; trial < TRIALS; trial++) {
  const pts = makeFleet(N, 1);
  const mo = makeMotion(N, 2, 12);
  const nc = new NetCluster({ radius: 40, maxZoom: 16 });

  let t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) nc.insert(i, pts[i * 2], pts[i * 2 + 1]);
  samples.insert.push(us(t, N));

  for (let i = 0; i < N; i++) { const [x, y] = step(pts, mo, i); nc.moveTo(i, x, y); }   // warm
  t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { const [x, y] = step(pts, mo, i); nc.moveTo(i, x, y); }
  samples.move.push(us(t, N));

  const R = 100_000;
  t = process.hrtime.bigint();
  for (let i = 0; i < R; i++) nc.remove(i);
  samples.remove.push(us(t, R));
  t = process.hrtime.bigint();
  for (let i = 0; i < R; i++) nc.insert(i, pts[i * 2], pts[i * 2 + 1]);
  samples.reinsert.push(us(t, R));

  last = { nc, pts };
}

const { nc, pts } = last;
const sc = new Supercluster({ radius: 40, maxZoom: 16, minZoom: 0 });
const feats = geojson(pts);
const t = process.hrtime.bigint();
sc.load(feats);
const scLoadMs = Number(process.hrtime.bigint() - t) / 1e6;

const reload = fmt(scLoadMs * 1000, 0) + ' us (full reload)';
table([
  { operation: 'insert 1 point',    netcluster: fmt(median(samples.insert), 2) + ' us',   supercluster: reload },
  { operation: 'move 1 point',      netcluster: fmt(median(samples.move), 2) + ' us',     supercluster: reload },
  { operation: 'remove 1 point',    netcluster: fmt(median(samples.remove), 2) + ' us',   supercluster: reload },
  { operation: 're-insert 1 point', netcluster: fmt(median(samples.reinsert), 2) + ' us', supercluster: reload },
]);
console.log('\n  N = ' + fmt(N, 0) + ' points, median of ' + TRIALS + ' trials');
console.log('  spread: ' + Object.entries(samples)
  .map(([k, v]) => `${k} ${fmt(Math.min(...v), 2)}-${fmt(Math.max(...v), 2)}`).join(', ') + ' us');
console.log('  netcluster index memory   ~ ' + fmt(ncBytes / 1e6) + ' MB  (self-reported ' + fmt(ncSelf / 1e6) + ' MB)');
console.log('  supercluster index memory ~ ' + fmt(scBytes / 1e6) + ' MB');
console.log('  sum_z |C_z| per point     = ' + fmt(entriesPerPoint, 2));
console.log('  fast-path moves           = ' + fmt(100 * nc.stats.movesFast / nc.stats.moves, 1) + '%');
console.log('  re-parent ops per remove  = ' + fmt(nc.stats.reparents / (nc.stats.removes + nc.stats.movesRebuilt), 2));
