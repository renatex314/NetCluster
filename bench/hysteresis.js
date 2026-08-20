// The one tuning knob: how far an existing assignment is allowed to stretch
// before the point is re-homed. Trades worst-case cluster radius against how
// often markers visibly change.
import { NetCluster, project, PREC } from '../src/netcluster.js';
import { makeFleet, makeMotion, step, table, fmt } from './common.js';

const N = 100_000, TICKS = 20, Z = 10, RADIUS = 40;
const rz = PREC * RADIUS / (512 * 2 ** Z);
const toPx = (d) => d / rz * RADIUS;
const rows = [];

for (const h of [0, 0.1, 0.25, 0.5, 1.0]) {
  const pts = makeFleet(N, 1);
  const mo = makeMotion(N, 2, 12);
  const nc = new NetCluster({ radius: RADIUS, maxZoom: 16, hysteresis: h });
  for (let i = 0; i < N; i++) nc.insert(i, pts[i * 2], pts[i * 2 + 1]);
  const prev = new Int32Array(N);
  for (let i = 0; i < N; i++) prev[i] = nc.representative(i, Z);
  let churn = 0, ns = 0;
  const t0 = process.hrtime.bigint();
  for (let tick = 0; tick < TICKS; tick++) {
    for (let i = 0; i < N; i++) { const [x, y] = step(pts, mo, i); nc.moveTo(i, x, y); }
  }
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { const r = nc.representative(i, Z); if (r !== prev[i]) churn++; }
  const qx = new Float64Array(N), qy = new Float64Array(N);
  for (let i = 0; i < N; i++) { const [a, b] = project(pts[i * 2], pts[i * 2 + 1]); qx[i] = a; qy[i] = b; }
  const cl = new Map();
  for (let i = 0; i < N; i++) { const k = nc.representative(i, Z); let c = cl.get(k); if (!c) cl.set(k, c = { n: 0, x: 0, y: 0 }); c.n++; c.x += qx[i]; c.y += qy[i]; }
  let sum = 0, max = 0; const ds = new Float64Array(N);
  for (let i = 0; i < N; i++) { const c = cl.get(nc.representative(i, Z)); const d = Math.hypot(qx[i] - c.x / c.n, qy[i] - c.y / c.n); ds[i] = d; sum += d; if (d > max) max = d; }
  ds.sort();
  const moves = TICKS * N;
  rows.push({
    hysteresis: h,
    'moves/s': fmt(moves / (Number(t1 - t0) / 1e9), 0),
    'fast path %': fmt(100 * nc.stats.movesFast / nc.stats.moves, 1),
    'churn/move': fmt(churn / moves, 4),
    clusters: fmt(cl.size, 0),
    'mean px': fmt(toPx(sum / N)),
    'p95 px': fmt(toPx(ds[Math.floor(N * 0.95)])),
    'max px': fmt(toPx(max)),
    'bound 2(1+h)r': fmt(2 * (1 + h) * RADIUS, 0),
  });
}
console.log('\n=== HYSTERESIS SWEEP (100,000 devices, 2,000,000 moves, zoom ' + Z + ') ===\n');
table(rows);
