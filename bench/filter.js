// Does carrying K category slices cost anything per update? A point belongs to
// one category, so it touches one slice -- the hot path should be flat in K.
// Re-homing moves whole subtrees, so removal is the one path that pays for K.
import { NetCluster } from '../src/netcluster.js';
import { makeFleet, makeMotion, step, table, fmt } from './common.js';

const N = 200_000;
const rows = [];
// Heap deltas inside a loop are dominated by GC timing, so the extra footprint
// is stated exactly instead: one Int32 count plus two Float64 sums, per point,
// per category.
const extraBytes = (n, k) => n * k * (4 + 8 + 8);

for (const K of [0, 2, 8, 32]) {
  const pts = makeFleet(N, 1), mo = makeMotion(N, 2, 12);
  const nc = new NetCluster({ radius: 40, maxZoom: 16, categories: K });
  const cat = (i) => (K > 0 ? { category: i % K } : undefined);

  let t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) nc.insert(i, pts[i * 2], pts[i * 2 + 1], cat(i));
  const insUs = Number(process.hrtime.bigint() - t) / 1000 / N;
  const bytes = extraBytes(N, K);

  for (let i = 0; i < N; i++) { const [x, y] = step(pts, mo, i); nc.moveTo(i, x, y); }
  t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { const [x, y] = step(pts, mo, i); nc.moveTo(i, x, y); }
  const movUs = Number(process.hrtime.bigint() - t) / 1000 / N;

  const R = 40_000;
  t = process.hrtime.bigint();
  for (let i = 0; i < R; i++) nc.remove(i);
  const remUs = Number(process.hrtime.bigint() - t) / 1000 / R;
  for (let i = 0; i < R; i++) nc.insert(i, pts[i * 2], pts[i * 2 + 1], cat(i));

  const VIEW = [-46.9, -23.75, -46.4, -23.35];
  const Q = 300;
  t = process.hrtime.bigint();
  let n1 = 0; for (let i = 0; i < Q; i++) n1 = nc.getClusters(VIEW, 11).length;
  const qAll = Number(process.hrtime.bigint() - t) / 1e6 / Q;
  let qOne = 0, n2 = 0;
  if (K > 0) {
    t = process.hrtime.bigint();
    for (let i = 0; i < Q; i++) n2 = nc.getClusters(VIEW, 11, 1).length;
    qOne = Number(process.hrtime.bigint() - t) / 1e6 / Q;
  }
  rows.push({
    categorias: K === 0 ? 'desligado' : K,
    'inserir': fmt(insUs, 2) + ' us',
    'mover': fmt(movUs, 2) + ' us',
    'remover': fmt(remUs, 2) + ' us',
    'memória extra': fmt(bytes / 1e6, 0) + ' MB',
    'consulta (tudo)': fmt(qAll, 3) + ' ms',
    'consulta (1 categoria)': K ? fmt(qOne, 3) + ' ms' : '-',
    'marcadores': K ? `${n1} / ${n2}` : String(n1),
  });
}
console.log('\n=== CUSTO DE MANTER K CATEGORIAS (N = ' + fmt(N, 0) + ') ===\n');
table(rows);
