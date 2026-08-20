// What the Redis-resident index actually costs, next to the in-process one.
import Redis from 'ioredis';
import { NetCluster } from '../src/netcluster.js';
import { RedisNetCluster } from '../server/redis-netcluster.js';
import { makeFleet, makeMotion, step, table, fmt } from './common.js';

const PORT = Number(process.env.REDIS_PORT || 6399);
const N = 100_000;
const OPTS = { radius: 40, maxZoom: 16, prefix: 'bench' };
const VIEWPORT = [-46.9, -23.75, -46.4, -23.35];

const pts = makeFleet(N, 1);
const mo = makeMotion(N, 2, 12);
const redis = new Redis(PORT);
const idx = new RedisNetCluster(redis, OPTS);
await idx.drop(); await idx.init();

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

// ---- load ----
let t0 = process.hrtime.bigint();
for (let i = 0; i < N; i += 500) {
  const batch = [];
  for (let j = i; j < Math.min(i + 500, N); j++) batch.push({ id: j, lng: pts[j * 2], lat: pts[j * 2 + 1] });
  await idx.upsertMany(batch);
}
const loadMs = ms(t0);

// ---- in-process reference on identical data ----
const mem = new NetCluster(OPTS);
t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) mem.insert(i, pts[i * 2], pts[i * 2 + 1]);
const memLoadMs = ms(t0);

// ---- moves: sequential (one await per device) ----
const SEQ = 3000;
for (let i = 0; i < SEQ; i++) { const [x, y] = step(pts, mo, i); await idx.upsert(i, x, y); }   // warm
t0 = process.hrtime.bigint();
for (let i = 0; i < SEQ; i++) { const [x, y] = step(pts, mo, i); await idx.upsert(i, x, y); }
const seqUs = ms(t0) * 1000 / SEQ;

// ---- moves: pipelined batches from one connection ----
const rows = [];
for (const B of [1, 10, 100, 500]) {
  const M = 20000;
  t0 = process.hrtime.bigint();
  for (let i = 0; i < M; i += B) {
    const batch = [];
    for (let j = i; j < Math.min(i + B, M); j++) { const [x, y] = step(pts, mo, j); batch.push({ id: j, lng: x, lat: y }); }
    await idx.upsertMany(batch);
  }
  const el = ms(t0);
  rows.push({ 'tamanho do lote': B, 'movimentos/s': fmt(M / (el / 1000), 0), 'µs por movimento': fmt(el * 1000 / M, 1) });
}

// ---- moves: many connections at once (simulating pods) ----
const podRows = [];
for (const PODS of [1, 4, 16]) {
  const clients = [], idxs = [];
  for (let p = 0; p < PODS; p++) { const c = new Redis(PORT); clients.push(c); idxs.push(new RedisNetCluster(c, OPTS)); }
  const M = 30000, B = 100;
  t0 = process.hrtime.bigint();
  await Promise.all(idxs.map((ix, p) => (async () => {
    for (let i = p * (M / PODS); i < (p + 1) * (M / PODS); i += B) {
      const batch = [];
      for (let j = i; j < Math.min(i + B, (p + 1) * (M / PODS)); j++) { const [x, y] = step(pts, mo, j); batch.push({ id: j, lng: x, lat: y }); }
      await ix.upsertMany(batch);
    }
  })()));
  const el = ms(t0);
  podRows.push({ 'conexões simultâneas': PODS, 'movimentos/s': fmt(M / (el / 1000), 0), 'µs por movimento': fmt(el * 1000 / M, 1) });
  for (const c of clients) c.disconnect();
}

// ---- in-process moves for reference ----
for (let i = 0; i < N; i++) { const [x, y] = step(pts, mo, i); mem.moveTo(i, x, y); }
t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) { const [x, y] = step(pts, mo, i); mem.moveTo(i, x, y); }
const memUs = ms(t0) * 1000 / N;

// ---- queries ----
const qrows = [];
for (const z of [6, 10, 14]) {
  const R = 200;
  t0 = process.hrtime.bigint();
  let n = 0;
  for (let i = 0; i < R; i++) n = (await idx.getClusters(VIEWPORT, z)).length;
  const rq = ms(t0) / R;
  t0 = process.hrtime.bigint();
  let m = 0;
  for (let i = 0; i < R; i++) m = mem.getClusters(VIEWPORT, z).length;
  const mq = ms(t0) / R;
  qrows.push({ zoom: z, 'clusters (redis)': n, 'clusters (in-process)': m,
               'consulta redis': fmt(rq, 2) + ' ms', 'consulta in-process': fmt(mq, 3) + ' ms' });
}

console.log('\n=== REDIS vs IN-PROCESS (N = ' + fmt(N, 0) + ', Redis local, sem persistência) ===\n');
table([
  { operação: 'carga inicial de 100k', redis: fmt(loadMs, 0) + ' ms', 'in-process': fmt(memLoadMs, 0) + ' ms' },
  { operação: 'mover 1 ponto (sequencial)', redis: fmt(seqUs, 1) + ' µs', 'in-process': fmt(memUs, 2) + ' µs' },
]);
console.log('\n  Movimentos com pipeline, uma conexão:\n');
table(rows);
console.log('\n  Movimentos com várias conexões (lote de 100):\n');
table(podRows);
console.log('\n  Consultas de viewport:\n');
table(qrows);
console.log(`\n  in-process, mesma máquina: ${fmt(memUs, 2)} µs/movimento (${fmt(1e6 / memUs, 0)} mov/s)`);
await idx.drop();
redis.disconnect();
