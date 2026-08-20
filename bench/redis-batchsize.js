// Pipelining raises throughput but Redis finishes a whole batch before serving
// anyone else, so the batch size IS the head-of-line blocking others see.
// This maps the trade-off, and checks whether routing reads to a replica really
// keeps the write primary free.
import Redis from 'ioredis';
import { RedisNetCluster } from '../server/redis-netcluster.js';
import { makeFleet, makeMotion, step, table, fmt } from './common.js';

const P = Number(process.env.REDIS_PORT || 6399), RP = 6400;
const redis = new Redis(P);
const idx = new RedisNetCluster(redis, { prefix: 'bs', radius: 40, maxZoom: 16 });
await idx.drop(); await idx.init();

const N = 200_000;
const pts = makeFleet(N, 1), mo = makeMotion(N, 2, 12);
for (let i = 0; i < N; i += 1000) {
  const b = [];
  for (let j = i; j < Math.min(i + 1000, N); j++) b.push({ id: j, lng: pts[j * 2], lat: pts[j * 2 + 1] });
  await idx.upsertMany(b);
}

const probe = new Redis(P);
await probe.set('probe', 'x');
async function probeFor(ms) {
  const lat = []; const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = process.hrtime.bigint();
    await probe.get('probe');
    lat.push(Number(process.hrtime.bigint() - t) / 1000);
  }
  lat.sort((a, b) => a - b);
  return { p50: lat[lat.length >> 1], p99: lat[Math.floor(lat.length * 0.99)] };
}

const rows = [];
let cursor = 0;
for (const B of [1, 5, 20, 50, 200]) {
  let stop = false, done = 0;
  const t0 = process.hrtime.bigint();
  const writer = (async () => {
    while (!stop) {
      const b = [];
      for (let k = 0; k < B; k++) { const j = (cursor++) % N; const [x, y] = step(pts, mo, j); b.push({ id: j, lng: x, lat: y }); }
      await idx.upsertMany(b); done += B;
    }
  })();
  const lat = await probeFor(2500);
  stop = true; await writer;
  const rate = done / (Number(process.hrtime.bigint() - t0) / 1e9);
  rows.push({ 'lote': B, 'movimentos/s': fmt(rate, 0),
              'p50 de outro cliente': fmt(lat.p50, 0) + ' us', 'p99 de outro cliente': fmt(lat.p99, 0) + ' us' });
}
console.log('\n=== O TAMANHO DO LOTE E O BLOQUEIO QUE OS OUTROS SENTEM ===\n');
table(rows);

// --- does sending reads to a replica keep the primary free? ---
const rd = new Redis(RP);
const idxRep = new RedisNetCluster(redis, { prefix: 'bs', radius: 40, maxZoom: 16, readFrom: rd });
await new Promise(r => setTimeout(r, 800));
let stopQ = false;
const q1 = (async () => { while (!stopQ) await idx.getClusters([-46.9, -23.75, -46.4, -23.35], 14); })();
const onPrimary = await probeFor(2500);
stopQ = true; await q1;

let stopQ2 = false;
const q2 = (async () => { while (!stopQ2) await idxRep.getClusters([-46.9, -23.75, -46.4, -23.35], 14); })();
const onReplica = await probeFor(2500);
stopQ2 = true; await q2;

console.log('\n=== CONSULTAS z14 EM LOOP: LATENCIA MEDIDA NO PRIMARIO ===\n');
table([
  { 'consultas vao para': 'o primario', 'p50 no primario': fmt(onPrimary.p50, 0) + ' us', 'p99 no primario': fmt(onPrimary.p99, 0) + ' us' },
  { 'consultas vao para': 'a replica', 'p50 no primario': fmt(onReplica.p50, 0) + ' us', 'p99 no primario': fmt(onReplica.p99, 0) + ' us' },
]);
await idx.drop();
probe.disconnect(); rd.disconnect(); redis.disconnect();
