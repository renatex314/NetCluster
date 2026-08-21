// The Redis index must behave EXACTLY like the in-process one, and must keep its
// invariants when several pods write concurrently. Both are checked here against
// a live Redis.
import Redis from 'ioredis';
import { NetCluster, project, PREC } from '../src/netcluster.js';
import { RedisNetCluster } from '../server/redis-netcluster.js';

const PORT = Number(process.env.REDIS_PORT || 6399);
const OPTS = { radius: 40, maxZoom: 16, hysteresis: 0.25 };
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };

let seed = 20260820;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const cities = [[-46.63, -23.55], [2.35, 48.85], [-74.0, 40.71], [139.69, 35.68], [-43.17, -22.9]];
const pick = () => rnd() < 0.75
  ? (() => { const c = cities[Math.floor(rnd() * cities.length)];
             return [c[0] + (rnd() - 0.5) * 0.4, c[1] + (rnd() - 0.5) * 0.4]; })()
  : [rnd() * 360 - 180, rnd() * 140 - 70];

// ---------------------------------------------------------------- invariants --
async function readState(redis, prefix, maxZoom) {
  const pts = new Map(), kids = new Map(), grid = new Map();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 1000);
    cursor = next;
    for (const k of keys) {
      const rest = k.slice(prefix.length + 1);
      if (rest.startsWith('p:')) {
        const h = await redis.hgetall(k);
        pts.set(rest.slice(2), { x: +h.x, y: +h.y, tz: +h.tz, par: h.par, cnt: +h.cnt, sx: +h.sx, sy: +h.sy });
      } else if (rest.startsWith('c:')) {
        kids.set(rest.slice(2), await redis.zrange(k, 0, -1, 'WITHSCORES'));
      } else if (rest.startsWith('g:')) {
        const [, z, cx, cy] = rest.split(':');
        grid.set(`${z}:${cx}:${cy}`, await redis.hgetall(k));
      }
    }
  } while (cursor !== '0');
  return { pts, kids, grid };
}

function checkInvariants(state, opts, label) {
  const { pts, kids, grid } = state;
  const { maxZoom, radius, hysteresis } = opts;
  const R = []; for (let z = 0; z <= maxZoom; z++) R[z] = PREC * radius / (512 * 2 ** z);
  const CS = R.map(r => 2 * r);
  const err = (m) => fail(`[${label}] ${m}`);

  // tree shape + covering
  for (const [id, p] of pts) {
    if (p.tz < 0 || p.tz > maxZoom + 1) err(`${id} has tz=${p.tz}`);
    if (p.tz === 0) { if (p.par !== '') err(`root ${id} has parent ${p.par}`); }
    else {
      if (!p.par) err(`${id}@${p.tz} has no parent`);
      const q = pts.get(p.par);
      if (!q) err(`${id} parent ${p.par} missing`);
      if (q.tz >= p.tz) err(`level inversion ${id}@${p.tz} under ${p.par}@${q.tz}`);
      const d2 = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      const lim = R[p.tz - 1] * (1 + hysteresis);
      if (d2 > lim * lim + 1e-6) err(`covering broken ${id}->${p.par}: ${Math.sqrt(d2).toFixed(0)} > ${lim.toFixed(0)}`);
    }
  }
  // separation, pairwise
  const centers = [...pts.entries()].filter(([, p]) => p.tz <= maxZoom);
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      const [ia, a] = centers[i], [ib, b] = centers[j];
      const z = Math.max(a.tz, b.tz);
      const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
      if (d2 <= R[z] * R[z] - 1e-6) {
        err(`separation broken at z=${z}: ${ia}@${a.tz} and ${ib}@${b.tz} are ${Math.sqrt(d2).toFixed(0)} apart, need > ${R[z].toFixed(0)}`);
      }
    }
  }
  // children lists agree with parent pointers, scores equal tz
  const seen = new Set();
  for (const [par, flat] of kids) {
    for (let i = 0; i < flat.length; i += 2) {
      const c = flat[i], score = +flat[i + 1];
      if (seen.has(c)) err(`${c} listed under two parents`);
      seen.add(c);
      const cp = pts.get(c);
      if (!cp) err(`child ${c} of ${par} does not exist`);
      if (cp.par !== par) err(`${c}.par=${cp.par} but listed under ${par}`);
      if (score !== cp.tz) err(`${c} score ${score} != tz ${cp.tz}`);
    }
  }
  for (const [id, p] of pts) if (p.par !== '' && !seen.has(id)) err(`${id} not in its parent's child set`);

  // aggregates vs brute-force subtree sums
  const childrenOf = new Map();
  for (const [id, p] of pts) if (p.par !== '') { if (!childrenOf.has(p.par)) childrenOf.set(p.par, []); childrenOf.get(p.par).push(id); }
  const sub = new Map();
  const visit = (id, depth) => {
    if (depth > 64) err(`cycle at ${id}`);
    const p = pts.get(id);
    let c = 1, sx = p.x, sy = p.y;
    for (const k of (childrenOf.get(id) || [])) { const t = visit(k, depth + 1); c += t[0]; sx += t[1]; sy += t[2]; }
    const t = [c, sx, sy]; sub.set(id, t); return t;
  };
  for (const [id, p] of pts) if (p.par === '') visit(id, 0);
  if (sub.size !== pts.size) err(`forest covers ${sub.size} of ${pts.size} points`);
  for (const [id, p] of pts) {
    const t = sub.get(id);
    if (p.cnt !== t[0]) err(`cnt[${id}]=${p.cnt} want ${t[0]}`);
    if (Math.abs(p.sx - t[1]) > 1e-6) err(`sx[${id}] off by ${p.sx - t[1]}`);
    if (Math.abs(p.sy - t[2]) > 1e-6) err(`sy[${id}] off by ${p.sy - t[2]}`);
  }
  // grid: every centre listed at exactly levels tz..maxZoom, right cell, right position
  const listed = new Map();
  for (const [cell, h] of grid) {
    const [z, cx, cy] = cell.split(':').map(Number);
    for (const [id, xy] of Object.entries(h)) {
      const p = pts.get(id);
      if (!p) err(`grid ${cell} holds dead id ${id}`);
      if (p.tz > z) err(`${id}@${p.tz} listed at level ${z}`);
      const [gx, gy] = xy.split(',').map(Number);
      if (gx !== p.x || gy !== p.y) err(`${id} position in grid ${cell} is ${xy}, record says ${p.x},${p.y}`);
      if (Math.floor(p.x / CS[z]) !== cx || Math.floor(p.y / CS[z]) !== cy) err(`${id} in wrong cell ${cell}`);
      const key = id + ':' + z;
      if (listed.has(key)) err(`${id} listed twice at level ${z}`);
      listed.set(key, 1);
    }
  }
  let expect = 0;
  for (const [id, p] of pts) {
    if (p.tz > maxZoom) continue;
    for (let z = p.tz; z <= maxZoom; z++) { if (!listed.has(id + ':' + z)) err(`${id}@${p.tz} missing from grid level ${z}`); expect++; }
  }
  if (listed.size !== expect) err(`grid holds ${listed.size} listings, expected ${expect}`);
  return { points: pts.size, centers: centers.length };
}

// ------------------------------------------------------------------- driver --
const redis = new Redis(PORT);
const idx = new RedisNetCluster(redis, { ...OPTS, prefix: 'itest' });
await idx.drop();
await idx.init();
const mem = new NetCluster(OPTS);
const live = new Map();

console.log('Redis integration tests (port ' + PORT + ')');

// --- 1. differential: identical partition at every zoom, op for op
const N0 = 250, STEPS = 900;
for (let i = 0; i < N0; i++) {
  const p = pick(); live.set(i, p);
  mem.insert(i, p[0], p[1]);
  await idx.upsert(i, p[0], p[1]);
}
let nextId = N0;

async function comparePartitions(label) {
  for (let z = 0; z <= OPTS.maxZoom; z += 4) {
    const groupsMem = new Map(), groupsRedis = new Map();
    for (const id of live.keys()) {
      const a = mem.representative(id, z);
      const b = await idx.representative(id, z);
      if (b === null) fail(`[${label}] device ${id} missing from redis at z=${z}`);
      if (!groupsMem.has(a)) groupsMem.set(a, []);
      if (!groupsRedis.has(b)) groupsRedis.set(b, []);
      groupsMem.get(a).push(id); groupsRedis.get(b).push(id);
    }
    const norm = (g) => [...g.values()].map(v => v.sort((x, y) => x - y).join(',')).sort().join('|');
    if (norm(groupsMem) !== norm(groupsRedis)) {
      const a = [...groupsMem.values()].length, b = [...groupsRedis.values()].length;
      fail(`[${label}] partitions differ at z=${z}: ${a} clusters in-process vs ${b} in redis`);
    }
  }
  // and the rendered output must agree too
  for (const z of [4, 10, 14]) {
    const A = mem.getClusters([-180, -85, 180, 85], z).map(f => `${f.properties.point_count || 1}`).sort().join(',');
    const B = (await idx.getClusters([-180, -85, 180, 85], z)).map(f => `${f.properties.point_count || 1}`).sort().join(',');
    if (A !== B) fail(`[${label}] getClusters output differs at z=${z}`);
  }
}
await comparePartitions('build');
console.log('  ok build: ' + live.size + ' devices, partitions identical at every zoom');

for (let step = 0; step < STEPS; step++) {
  const u = rnd(), keys = [...live.keys()];
  if (u < 0.55 && keys.length) {
    const id = keys[Math.floor(rnd() * keys.length)], p = live.get(id);
    const q = rnd() < 0.85 ? [p[0] + (rnd() - 0.5) * 0.02, p[1] + (rnd() - 0.5) * 0.02] : pick();
    live.set(id, q); mem.moveTo(id, q[0], q[1]); await idx.upsert(id, q[0], q[1]);
  } else if (u < 0.78) {
    const p = pick(); live.set(nextId, p); mem.insert(nextId, p[0], p[1]); await idx.upsert(nextId, p[0], p[1]); nextId++;
  } else if (keys.length) {
    const id = keys[Math.floor(rnd() * keys.length)];
    live.delete(id); mem.remove(id); await idx.remove(id);
  }
  if (step % 300 === 0) await comparePartitions('step' + step);
}
await comparePartitions('final');
const st = checkInvariants(await readState(redis, 'itest', OPTS.maxZoom), OPTS, 'final');
console.log(`  ok ${STEPS} mixed ops: partitions identical, all invariants hold in Redis ` +
            `(${st.points} points, ${st.centers} centers)`);
if (await idx.size() !== live.size) fail(`count drifted: redis ${await idx.size()} vs ${live.size}`);

// --- 2. concurrency: many "pods" writing at once must not break separation
await idx.drop(); await idx.init();
const PODS = 8, PER_POD = 400;
const clients = [], pods = [];
for (let p = 0; p < PODS; p++) {
  const c = new Redis(PORT); clients.push(c);
  pods.push(new RedisNetCluster(c, { ...OPTS, prefix: 'itest' }));
}
const conc = [];
for (let i = 0; i < PODS * PER_POD; i++) {
  const c = cities[i % cities.length];
  conc.push([i, c[0] + (rnd() - 0.5) * 0.15, c[1] + (rnd() - 0.5) * 0.15]);
}
await Promise.all(pods.map((pod, p) =>
  (async () => {
    for (let i = p; i < conc.length; i += PODS) await pod.upsert(conc[i][0], conc[i][1], conc[i][2]);
  })()));
// then move them all concurrently, interleaved across pods
await Promise.all(pods.map((pod, p) =>
  (async () => {
    for (let i = p; i < conc.length; i += PODS) {
      const c = conc[i];
      await pod.upsert(c[0], c[1] + (rnd() - 0.5) * 0.01, c[2] + (rnd() - 0.5) * 0.01);
    }
  })()));
const st2 = checkInvariants(await readState(redis, 'itest', OPTS.maxZoom), OPTS, 'concurrent');
if (st2.points !== conc.length) fail(`concurrent writes lost points: ${st2.points} of ${conc.length}`);
console.log(`  ok ${PODS} concurrent clients x ${PER_POD} devices: no invariant broken ` +
            `(${st2.points} points, ${st2.centers} centers)`);

// --- 3. a pod dying mid-stream must leave the index consistent
const killed = new Redis(PORT);
const dying = new RedisNetCluster(killed, { ...OPTS, prefix: 'itest' });
const inflight = [];
for (let i = 0; i < 60; i++) inflight.push(dying.upsert('doomed' + i, -46.63 + rnd() * 0.1, -23.55 + rnd() * 0.1));
killed.disconnect();                       // pull the plug mid-flight
await Promise.allSettled(inflight);
const st3 = checkInvariants(await readState(redis, 'itest', OPTS.maxZoom), OPTS, 'after-kill');
console.log(`  ok pod killed mid-write: index still consistent (${st3.points} points)`);

// --- 4. has(): the Redis answer must match the in-process one for every id
{
  const hidx = new RedisNetCluster(redis, { ...OPTS, prefix: 'hastest' });
  await hidx.drop();
  await hidx.init();
  const mem = new NetCluster(OPTS);

  if (await hidx.has('truck-1')) fail('has() true on an empty index');
  await hidx.upsert('truck-1', -46.6333, -23.5505);
  if (!(await hidx.has('truck-1'))) fail('has() false after upsert');
  await hidx.upsert('truck-1', -46.70, -23.60);
  if (!(await hidx.has('truck-1'))) fail('has() false after a move');
  await hidx.remove('truck-1');
  if (await hidx.has('truck-1')) fail('has() true after remove');
  await hidx.upsert('truck-1', 0, 0);
  if (!(await hidx.has('truck-1'))) fail('has() false after re-insert');
  await hidx.drop();
  await hidx.init();

  // Same operation stream against both backends, then compare every id.
  const live = new Set();
  for (let i = 0; i < 400; i++) {
    const id = 'v' + Math.floor(rnd() * 150);
    if (rnd() < 0.25 && live.size) {
      const victim = [...live][Math.floor(rnd() * live.size)];
      await hidx.remove(victim); mem.remove(victim); live.delete(victim);
    } else {
      const [lng, lat] = pick();
      await hidx.upsert(id, lng, lat); mem.insert(id, lng, lat); live.add(id);
    }
  }
  let mismatch = 0;
  for (let i = 0; i < 150; i++) {
    const id = 'v' + i;
    if ((await hidx.has(id)) !== mem.has(id)) mismatch++;
  }
  if (mismatch) fail(`has() disagrees with the in-process index on ${mismatch} ids`);
  if ((await hidx.size()) !== mem.size) fail('size disagrees after the same operations');
  console.log(`  ok has(): Redis and in-process agree on all 150 ids (${live.size} live)`);
  await hidx.drop();
}

await idx.drop();
for (const c of clients) c.disconnect();
killed.disconnect();
redis.disconnect();
console.log('REDIS INTEGRATION TESTS PASSED');
