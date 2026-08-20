// Stateless HTTP front end. Every instance is interchangeable and holds nothing
// between requests: scale it to N pods behind a load balancer, kill any of them
// at any time. All state lives in Redis.
//
//   REDIS_URL=redis://localhost:6379 PORT=3000 node server/server.js
import Fastify from 'fastify';
import Redis from 'ioredis';
import { RedisNetCluster } from './redis-netcluster.js';

const PORT = Number(process.env.PORT || 3000);
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const TILE_TTL = Number(process.env.TILE_TTL_MS || 0);   // >0 caches cluster responses

const READ_URL = process.env.REDIS_READ_URL;          // optional read replica
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, enableAutoPipelining: true });
const reader = READ_URL ? new Redis(READ_URL, { maxRetriesPerRequest: 3, enableAutoPipelining: true }) : undefined;
const index = new RedisNetCluster(redis, {
  readFrom: reader,
  prefix: process.env.NC_PREFIX || 'nc',
  radius: Number(process.env.NC_RADIUS || 40),
  maxZoom: Number(process.env.NC_MAXZOOM || 16),
  hysteresis: Number(process.env.NC_HYSTERESIS || 0.25),
  maxPipeline: Number(process.env.NC_MAX_PIPELINE || 25),
});
await index.init();

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'warn' } });

const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw app.httpErrors ? new Error(`${name} must be a number`) : new Error(`${name} must be a number`);
  return n;
};

app.get('/health', async () => ({ ok: true, points: await index.size() }));

/** Report one device's position. Idempotent: insert and move are the same call. */
app.post('/devices/:id', async (req, reply) => {
  const { lng, lat } = req.body ?? {};
  if (!Number.isFinite(Number(lng)) || !Number.isFinite(Number(lat))) {
    return reply.code(400).send({ error: 'lng and lat are required numbers' });
  }
  const r = await index.upsert(req.params.id, Number(lng), Number(lat));
  return { result: ['unchanged', 'inserted', 'moved', 'moved+repaired'][r] };
});

/** Batch of position reports; sent as one Redis pipeline. */
app.post('/devices', async (req, reply) => {
  const points = req.body;
  if (!Array.isArray(points) || points.length === 0) {
    return reply.code(400).send({ error: 'expected a non-empty array of {id, lng, lat}' });
  }
  if (points.length > 10000) return reply.code(413).send({ error: 'batch limited to 10000 points' });
  for (const p of points) {
    if (!p || p.id === undefined || !Number.isFinite(Number(p.lng)) || !Number.isFinite(Number(p.lat))) {
      return reply.code(400).send({ error: 'each item needs id, lng and lat' });
    }
  }
  const res = await index.upsertMany(points.map(p => ({ id: p.id, lng: Number(p.lng), lat: Number(p.lat) })));
  return { accepted: res.length };
});

app.delete('/devices/:id', async (req) => ({ removed: (await index.remove(req.params.id)) === 1 }));

/** Clusters in a viewport. bbox=west,south,east,north */
app.get('/clusters', async (req, reply) => {
  const { bbox, zoom, limit } = req.query;
  const parts = String(bbox ?? '').split(',').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
    return reply.code(400).send({ error: 'bbox must be west,south,east,north' });
  }
  const z = Number(zoom);
  if (!Number.isFinite(z)) return reply.code(400).send({ error: 'zoom is required' });

  const cacheKey = TILE_TTL > 0 ? `${index.prefix}:q:${parts.join(',')}:${Math.floor(z)}` : null;
  if (cacheKey) {
    const hit = await redis.get(cacheKey);
    if (hit) { reply.header('x-cache', 'hit'); return reply.type('application/json').send(hit); }
  }
  const features = await index.getClusters(parts, z, Math.min(Number(limit) || 5000, 20000));
  const body = JSON.stringify({ type: 'FeatureCollection', features });
  if (cacheKey) await redis.set(cacheKey, body, 'PX', TILE_TTL);
  reply.header('x-cache', cacheKey ? 'miss' : 'off');
  return reply.type('application/json').send(body);
});

/** Which cluster is this device drawn inside at a given zoom? */
app.get('/devices/:id/cluster', async (req, reply) => {
  const z = Number(req.query.zoom);
  if (!Number.isFinite(z)) return reply.code(400).send({ error: 'zoom is required' });
  const rep = await index.representative(req.params.id, Math.floor(z));
  if (rep === null) return reply.code(404).send({ error: 'unknown device' });
  return { device: req.params.id, zoom: Math.floor(z), cluster: rep };
});

/**
 * Clusters for one Web-Mercator tile. Prefer this over /clusters for map
 * clients: the key is stable, so the tile cache actually hits, whereas a
 * free-form bbox changes on every pan and never hits.
 */
app.get('/tile/:z/:x/:y', async (req, reply) => {
  const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y);
  const n = 2 ** z;
  if (!Number.isInteger(z) || z < 0 || z > 22 || !(x >= 0 && x < n) || !(y >= 0 && y < n)) {
    return reply.code(400).send({ error: 'bad tile coordinates' });
  }
  const key = `${index.prefix}:t:${z}:${x}:${y}`;
  if (TILE_TTL > 0) {
    const hit = await redis.get(key);
    if (hit) { reply.header('x-cache', 'hit'); return reply.type('application/json').send(hit); }
  }
  const lat = (t) => Math.atan(Math.sinh(Math.PI * (1 - 2 * t))) * 180 / Math.PI;
  const bbox = [x / n * 360 - 180, lat((y + 1) / n), (x + 1) / n * 360 - 180, lat(y / n)];
  const features = await index.getClusters(bbox, z);
  const body = JSON.stringify({ type: 'FeatureCollection', features });
  if (TILE_TTL > 0) await redis.set(key, body, 'PX', TILE_TTL);
  reply.header('x-cache', TILE_TTL > 0 ? 'miss' : 'off');
  return reply.type('application/json').send(body);
});

/** Debug only: SCANs the keyspace. */
app.get('/stats', async () => index.stats());

await app.listen({ port: PORT, host: '0.0.0.0' });
console.error(`netcluster listening on :${PORT} -> ${REDIS_URL}` +
              (READ_URL ? ` (reads from ${READ_URL})` : '') + ` (tile cache ${TILE_TTL ? TILE_TTL + 'ms' : 'off'})`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await app.close(); redis.disconnect(); reader?.disconnect(); process.exit(0); });
}
