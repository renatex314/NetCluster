// What does filtering cost?
//
// Two questions, two tables. First: does carrying the aggregates slow the index
// down -- a device touches one cell per shape, so the hot path should stay flat
// in how many values exist. Second: what do conjunctions and multi-valued
// dimensions cost, which is the case a dense slice per combination cannot hold at
// all.
import { NetCluster } from '../src/netcluster.js';
import { makeFleet, makeMotion, step, table, fmt } from './common.js';

const N = 200_000;
const VIEW = [-46.9, -23.75, -46.4, -23.35];
const Q = 300;

/** insert / move / remove / query, for one schema */
function run(opts, propsFor, filter) {
  const pts = makeFleet(N, 1), mo = makeMotion(N, 2, 12);
  const nc = new NetCluster({ radius: 40, maxZoom: 16, ...opts });

  let t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) nc.insert(i, pts[i * 2], pts[i * 2 + 1], propsFor(i));
  const ins = Number(process.hrtime.bigint() - t) / 1000 / N;

  for (let i = 0; i < N; i++) { const [x, y] = step(pts, mo, i); nc.moveTo(i, x, y); }
  t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { const [x, y] = step(pts, mo, i); nc.moveTo(i, x, y); }
  const mov = Number(process.hrtime.bigint() - t) / 1000 / N;

  const R = 40_000;
  t = process.hrtime.bigint();
  for (let i = 0; i < R; i++) nc.remove(i);
  const rem = Number(process.hrtime.bigint() - t) / 1000 / R;
  for (let i = 0; i < R; i++) nc.insert(i, pts[i * 2], pts[i * 2 + 1], propsFor(i));

  t = process.hrtime.bigint();
  let nAll = 0; for (let i = 0; i < Q; i++) nAll = nc.getClusters(VIEW, 11).length;
  const qAll = Number(process.hrtime.bigint() - t) / 1e6 / Q;

  let qOne = 0, nOne = 0;
  if (filter !== undefined) {
    t = process.hrtime.bigint();
    for (let i = 0; i < Q; i++) nOne = nc.getClusters(VIEW, 11, filter).length;
    qOne = Number(process.hrtime.bigint() - t) / 1e6 / Q;
  }

  // Last, because it rewrites every device's values and so changes what the
  // queries above would have counted. `step` left each device's current position
  // in `pts`, so re-reporting it moves nothing and exercises only re-filing --
  // the case a position-keyed index used to miss entirely, and the one a fleet
  // generates all day.
  let chg = 0;
  if (filter !== undefined) {
    t = process.hrtime.bigint();
    for (let i = 0; i < N; i++) nc.moveTo(i, pts[i * 2], pts[i * 2 + 1], propsFor(i + 1));
    chg = Number(process.hrtime.bigint() - t) / 1000 / N;
  }
  return { nc, ins, mov, rem, chg, qAll, qOne, nAll, nOne };
}

// ------------------------------------------------- one dimension, as before --
const rows = [];
for (const K of [0, 2, 8, 32]) {
  const opts = K > 0 ? { categories: K } : {};
  const r = run(opts, K > 0 ? (i) => ({ category: i % K }) : () => undefined, K > 0 ? 1 : undefined);
  rows.push({
    categorias: K === 0 ? 'desligado' : K,
    'camada': K === 0 ? '-' : (r.nc.dense ? 'densa' : 'esparsa'),
    'inserir': fmt(r.ins, 2) + ' us',
    'mover': fmt(r.mov, 2) + ' us',
    'remover': fmt(r.rem, 2) + ' us',
    'refiltrar': K ? fmt(r.chg, 2) + ' us' : '-',
    'memória': fmt(r.nc.memoryBytes() / 1e6, 0) + ' MB',
    'consulta (tudo)': fmt(r.qAll, 3) + ' ms',
    'consulta (1 categoria)': K ? fmt(r.qOne, 3) + ' ms' : '-',
    'marcadores': K ? `${r.nAll} / ${r.nOne}` : String(r.nAll),
  });
}
console.log('\n=== UMA DIMENSAO: O QUE CUSTA MANTER K CATEGORIAS (N = ' + fmt(N, 0) + ') ===\n');
table(rows);

// ------------------------------------ several dimensions, combined filters --
// `denseCells` forces the layout so the two can be compared on the same schema
// rather than only where each is chosen automatically.
const CLIENTS = 40, STATUS = ['idle', 'enroute', 'loading', 'maint'];
const shapes = [['client'], ['status'], ['client', 'status']];
// Values must be drawn independently. Deriving both from `i` with modular
// arithmetic correlates them -- `i % 40 == 7` forces `i % 4 == 3` -- so a
// conjunction matches nothing and the row silently measures an empty query.
const rnd = (() => { let s = 12345;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; })();
const CLIENT_OF = new Int32Array(N), CLIENT2_OF = new Int32Array(N), STATUS_OF = new Int32Array(N);
for (let i = 0; i < N; i++) {
  CLIENT_OF[i] = Math.floor(rnd() * CLIENTS);
  CLIENT2_OF[i] = Math.floor(rnd() * CLIENTS);
  STATUS_OF[i] = Math.floor(rnd() * STATUS.length);
}
const one = (i) => ({ client: CLIENT_OF[i % N] });
const multi = (i) => ({ client: [CLIENT_OF[i % N], CLIENT2_OF[i % N]], status: STATUS[STATUS_OF[i % N]] });

const rows2 = [];
for (const [label, opts, filter, mk] of [
  ['1 cliente', { dimensions: { client: CLIENTS }, filters: [['client']] }, { client: 7 }, one],
  ['1 cliente, multi', { dimensions: { client: { values: CLIENTS, multi: true } }, filters: [['client']] }, { client: 7 }, multi],
  ['cliente x estado', { dimensions: { client: { values: CLIENTS, multi: true }, status: STATUS }, filters: shapes }, { client: 7, status: 'enroute' }, multi],
  ['cliente sozinho', { dimensions: { client: { values: CLIENTS, multi: true }, status: STATUS }, filters: shapes }, { client: 7 }, multi],
  ['5 clientes x estado', { dimensions: { client: { values: 5, multi: true }, status: STATUS }, filters: shapes }, { client: 3, status: 'enroute' },
   (i) => ({ client: [CLIENT_OF[i % N] % 5, CLIENT2_OF[i % N] % 5], status: STATUS[STATUS_OF[i % N]] })],
]) {
  const r = run(opts, mk, filter);
  rows2.push({
    'filtro': label,
    'camada': r.nc.dense ? 'densa' : 'esparsa',
    'células': r.nc.schema.cellCount,
    'entradas': fmt(r.nc.aggEntries() / 1e6, 2) + 'M',
    'memória': fmt(r.nc.memoryBytes() / 1e6, 0) + ' MB',
    'inserir': fmt(r.ins, 2) + ' us',
    'remover': fmt(r.rem, 2) + ' us',
    'refiltrar': fmt(r.chg, 2) + ' us',
    'consulta': fmt(r.qOne, 3) + ' ms',
    'marcadores': `${r.nAll} / ${r.nOne}`,
  });
}
console.log('\n=== VARIAS DIMENSOES: CONJUNCOES E VALORES MULTIPLOS (N = ' + fmt(N, 0) + ') ===\n');
table(rows2);

// ------------------------------------------------------ dense vs sparse -----
// The same schema in both layouts, so the trade the automatic choice is making
// is visible rather than asserted.
const rows3 = [];
for (const denseCells of [4096, 0]) {
  const opts = { dimensions: { client: { values: CLIENTS, multi: true }, status: STATUS }, filters: shapes, denseCells };
  const r = run(opts, multi, { client: 7, status: 'enroute' });
  rows3.push({
    'camada': r.nc.dense ? 'densa' : 'esparsa',
    'memória': fmt(r.nc.memoryBytes() / 1e6, 0) + ' MB',
    'inserir': fmt(r.ins, 2) + ' us',
    'mover': fmt(r.mov, 2) + ' us',
    'remover': fmt(r.rem, 2) + ' us',
    'consulta': fmt(r.qOne, 3) + ' ms',
  });
}
console.log('\n=== A MESMA CONSULTA NAS DUAS CAMADAS (cliente x estado, ' +
            (CLIENTS + STATUS.length + CLIENTS * STATUS.length) + ' células) ===\n');
table(rows3);
