// Does quality decay under a continuous stream of updates, with no rebuild?
import { NetCluster, project, PREC } from '../src/netcluster.js';
import { GreedyIncremental } from './greedy.js';
import { makeFleet, makeMotion, step, table, fmt } from './common.js';

const N = 100_000;
const TICKS = 50;                 // 50 * N = 5,000,000 moves
const Z = 10;                     // zoom under observation
const RADIUS = 40;
const rz = PREC * RADIUS / (512 * 2 ** Z);
const toPx = (d) => d / rz * RADIUS;

const pts = makeFleet(N, 1);
const mo = makeMotion(N, 2, 12);

const nc = new NetCluster({ radius: RADIUS, maxZoom: 16 });
const gr = new GreedyIncremental(Z, RADIUS);
for (let i = 0; i < N; i++) { nc.insert(i, pts[i * 2], pts[i * 2 + 1]); gr.insert(i, pts[i * 2], pts[i * 2 + 1]); }

function metrics(assign, positions) {
  const cl = new Map();
  for (let i = 0; i < N; i++) {
    const k = assign(i);
    let c = cl.get(k); if (!c) cl.set(k, c = { n: 0, x: 0, y: 0 });
    const [x, y] = positions(i);
    c.n++; c.x += x; c.y += y;
  }
  let sum = 0, max = 0;
  const ds = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const c = cl.get(assign(i)); const [x, y] = positions(i);
    const d = Math.hypot(x - c.x / c.n, y - c.y / c.n);
    ds[i] = d; sum += d; if (d > max) max = d;
  }
  ds.sort();
  return { k: cl.size, mean: toPx(sum / N), p95: toPx(ds[Math.floor(N * 0.95)]), max: toPx(max) };
}
const qx = new Float64Array(N), qy = new Float64Array(N);
const syncPos = () => { for (let i = 0; i < N; i++) { const [a, b] = project(pts[i * 2], pts[i * 2 + 1]); qx[i] = a; qy[i] = b; } };
const posOf = (i) => [qx[i], qy[i]];

const rows = [];
let prevRep = new Int32Array(N);
syncPos();
for (let i = 0; i < N; i++) prevRep[i] = nc.representative(i, Z);

for (let tick = 0; tick <= TICKS; tick++) {
  if (tick % 10 === 0) {
    syncPos();
    const mine = metrics((i) => nc.representative(i, Z), posOf);
    const fresh = new NetCluster({ radius: RADIUS, maxZoom: 16 });
    for (let i = 0; i < N; i++) fresh.insert(i, pts[i * 2], pts[i * 2 + 1]);
    const ref = metrics((i) => fresh.representative(i, Z), posOf);
    const g = metrics((i) => gr.representative(i), posOf);
    // recourse: how many points changed their drawn cluster since the last sample
    let churn = 0;
    for (let i = 0; i < N; i++) { const r = nc.representative(i, Z); if (r !== prevRep[i]) churn++; prevRep[i] = r; }
    rows.push({
      'moves so far': fmt(tick * N, 0),
      'nc clusters': fmt(mine.k, 0), 'nc mean px': fmt(mine.mean), 'nc p95 px': fmt(mine.p95), 'nc max px': fmt(mine.max),
      'rebuilt clusters': fmt(ref.k, 0), 'rebuilt mean px': fmt(ref.mean), 'rebuilt max px': fmt(ref.max),
      'greedy clusters': fmt(g.k, 0), 'greedy mean px': fmt(g.mean), 'greedy max px': fmt(g.max),
      'churn/move': tick === 0 ? '-' : fmt(churn / (10 * N), 3),
    });
  }
  if (tick === TICKS) break;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { const [x, y] = step(pts, mo, i); nc.moveTo(i, x, y); }
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) gr.moveTo(i, pts[i * 2], pts[i * 2 + 1]);
  if (tick % 10 === 0) process.stderr.write(`  tick ${tick}: ${fmt(N / (Number(t1 - t0) / 1e9) / 1000, 0)}k moves/s\n`);
}

console.log('\n=== QUALITY UNDER 5,000,000 CONTINUOUS MOVES (no rebuild, zoom ' + Z + ') ===\n');
table(rows.map(r => ({ 'moves so far': r['moves so far'], 'nc clusters': r['nc clusters'],
  'nc mean px': r['nc mean px'], 'nc p95 px': r['nc p95 px'], 'nc max px': r['nc max px'],
  'churn/move': r['churn/move'] })));
console.log('\n  reference: a *freshly rebuilt* index over the same positions\n');
table(rows.map(r => ({ 'moves so far': r['moves so far'], 'rebuilt clusters': r['rebuilt clusters'],
  'rebuilt mean px': r['rebuilt mean px'], 'rebuilt max px': r['rebuilt max px'] })));
console.log('\n  baseline: incremental greedy / leader clustering, same O(1)-ish updates, no repair\n');
table(rows.map(r => ({ 'moves so far': r['moves so far'], 'greedy clusters': r['greedy clusters'],
  'greedy mean px': r['greedy mean px'], 'greedy max px': r['greedy max px'] })));
console.log('\n  final index stats:', JSON.stringify(nc.stats));
console.log('  grid listings sum_z |C_z| =', fmt(nc.gridEntries(), 0), '=', fmt(nc.gridEntries() / N, 2), 'per point');
console.log('  memory ~', fmt(nc.memoryBytes() / 1e6), 'MB');
