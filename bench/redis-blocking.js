// How long does each script actually own the Redis thread, and what does that do
// to everyone else? INFO commandstats reports in-server execution time per call,
// which is exactly the blocking duration -- client-side timings would hide it.
import Redis from 'ioredis';
import { RedisNetCluster } from '../server/redis-netcluster.js';
import { makeFleet, makeMotion, step, table, fmt } from './common.js';

const PORT = Number(process.env.REDIS_PORT || 6399);
const redis = new Redis(PORT);

async function cmdstats(redis) {
  const raw = await redis.info('commandstats');
  const out = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^cmdstat_(\w+):calls=(\d+),usec=(\d+),usec_per_call=([\d.]+)/);
    if (m) out[m[1]] = { calls: +m[2], usec: +m[3], per: +m[4] };
  }
  return out;
}

const rows = [];
for (const N of [10_000, 100_000, 1_000_000]) {
  const idx = new RedisNetCluster(redis, { prefix: `blk${N}`, radius: 40, maxZoom: 16 });
  await idx.drop(); await idx.init();
  const pts = makeFleet(N, 1);
  const mo = makeMotion(N, 2, 12);
  for (let i = 0; i < N; i += 1000) {
    const b = [];
    for (let j = i; j < Math.min(i + 1000, N); j++) b.push({ id: j, lng: pts[j * 2], lat: pts[j * 2 + 1] });
    await idx.upsertMany(b);
  }
  const M = Math.min(N, 30_000);
  for (let i = 0; i < M; i++) { const [x, y] = step(pts, mo, i); await idx.upsert(i, x, y); }   // warm

  await redis.config('RESETSTAT');
  for (let i = 0; i < M; i += 200) {
    const b = [];
    for (let j = i; j < Math.min(i + 200, M); j++) { const [x, y] = step(pts, mo, j); b.push({ id: j, lng: x, lat: y }); }
    await idx.upsertMany(b);
  }
  const w = (await cmdstats(redis)).evalsha;

  const qs = {};
  for (const z of [8, 10, 14]) {
    await redis.config('RESETSTAT');
    for (let i = 0; i < 50; i++) await idx.getClusters([-46.9, -23.75, -46.4, -23.35], z);
    const s = await cmdstats(redis);
    qs[z] = (s.evalsha_ro || s.eval_ro || { per: 0 }).per;
  }
  rows.push({
    N: fmt(N, 0),
    'upsert: bloqueio/chamada': fmt(w.per, 1) + ' us',
    'consulta z8': fmt(qs[8], 0) + ' us',
    'consulta z10': fmt(qs[10], 0) + ' us',
    'consulta z14': fmt(qs[14], 0) + ' us',
  });
  if (N !== 1_000_000) await idx.drop();
}
console.log('\n=== TEMPO QUE CADA SCRIPT OCUPA A THREAD DO REDIS ===');
console.log('  (INFO commandstats: tempo de execucao dentro do servidor)\n');
table(rows);

// --- what it does to an unrelated client ---
console.log('\n=== LATENCIA DE UM CLIENTE QUALQUER (GET simples) ===\n');
const probe = new Redis(PORT);
await probe.set('probe', 'x');
async function probeLatency(ms) {
  const lat = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = process.hrtime.bigint();
    await probe.get('probe');
    lat.push(Number(process.hrtime.bigint() - t) / 1000);
  }
  lat.sort((a, b) => a - b);
  return { p50: lat[lat.length >> 1], p99: lat[Math.floor(lat.length * 0.99)], max: lat[lat.length - 1], n: lat.length };
}
const idle = await probeLatency(1500);

const idx = new RedisNetCluster(redis, { prefix: 'blk1000000', radius: 40, maxZoom: 16 });
const pts = makeFleet(1_000_000, 1);
const mo = makeMotion(1_000_000, 2, 12);
let stop = false;
const writer = (async () => {
  let i = 0;
  while (!stop) {
    const b = [];
    for (let k = 0; k < 200; k++) { const j = (i++) % 1_000_000; const [x, y] = step(pts, mo, j); b.push({ id: j, lng: x, lat: y }); }
    await idx.upsertMany(b);
  }
})();
const underWrites = await probeLatency(2500);
stop = true; await writer;

let stopQ = false;
const querier = (async () => { while (!stopQ) await idx.getClusters([-46.9, -23.75, -46.4, -23.35], 14); })();
const underQueries = await probeLatency(2500);
stopQ = true; await querier;

table([
  { cenário: 'redis ocioso', p50: fmt(idle.p50, 0) + ' us', p99: fmt(idle.p99, 0) + ' us', 'pior caso': fmt(idle.max, 0) + ' us' },
  { cenário: 'sob carga de escrita', p50: fmt(underWrites.p50, 0) + ' us', p99: fmt(underWrites.p99, 0) + ' us', 'pior caso': fmt(underWrites.max, 0) + ' us' },
  { cenário: 'sob consultas z14', p50: fmt(underQueries.p50, 0) + ' us', p99: fmt(underQueries.p99, 0) + ' us', 'pior caso': fmt(underQueries.max, 0) + ' us' },
]);
await idx.drop();
probe.disconnect(); redis.disconnect();
