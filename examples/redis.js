// The same index, resident in Redis, driven by a stateless client.
// Needs a Redis server:  redis-server --port 6379
// Run it:                node examples/redis.js
import Redis from 'ioredis';
import { RedisNetCluster } from '../server/redis-netcluster.js';   // 'netcluster-js/redis'

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const index = new RedisNetCluster(redis, {
  prefix: 'example',
  radius: 40,
  maxZoom: 16,
  // readFrom: new Redis(process.env.REDIS_READ_URL),  // serve queries off a replica
});

await index.drop();      // start clean, for the example only
await index.init();      // publishes the geometry every pod must agree on

// --- load a fleet. upsertMany splits into safe pipelines internally. ---------
const FLEET = 5000;
const batch = [];
for (let i = 0; i < FLEET; i++) {
  batch.push({ id: `vehicle-${i}`,
    lng: -46.63 + (Math.random() - 0.5) * 0.25,
    lat: -23.55 + (Math.random() - 0.5) * 0.25 });
}
await index.upsertMany(batch);
console.log(`${await index.size()} vehicles in Redis`);

// --- insert and move are the same call --------------------------------------
const RESULT = ['unchanged', 'inserted', 'moved', 'moved+repaired'];
console.log('upsert new device  ->', RESULT[await index.upsert('vehicle-new', -46.64, -23.56)]);
console.log('upsert same device ->', RESULT[await index.upsert('vehicle-new', -46.65, -23.57)]);

// --- read ---------------------------------------------------------------------
const bbox = [-47, -24, -46, -23];
for (const z of [8, 11, 14]) {
  const f = await index.getClusters(bbox, z);
  console.log(`zoom ${String(z).padStart(2)}: ${f.length} features, ` +
              `${f.reduce((a, x) => a + (x.properties.point_count || 1), 0)} vehicles`);
}
console.log('vehicle-new is drawn inside', await index.representative('vehicle-new', 11));

await index.remove('vehicle-new');
console.log(`after remove: ${await index.size()} vehicles`);

await index.drop();
redis.disconnect();
