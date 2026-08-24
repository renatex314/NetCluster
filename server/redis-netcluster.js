// Stateless client for the Redis-resident net hierarchy.
//
// This object holds no index state: it is a thin wrapper that ships arguments to
// Lua and decodes results. Any number of processes may share one Redis, and a
// process may be killed between any two calls. ioredis sends EVALSHA and falls
// back to EVAL on NOSCRIPT, so a cold pod needs no coordination to start.
//
// Requires a single Redis primary (replicas for reads are fine). The scripts
// touch keys derived from geometry, which cannot be co-located behind one hash
// tag, so Redis Cluster would need the region-sharded topology instead.
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { project, PREC } from '../src/netcluster.js';
import { readFeature, featuresOf } from '../src/geojson.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const lua = (f) => readFileSync(join(HERE, 'lua', f), 'utf8');
const COMMON = lua('common.lua');
const sha1 = (s) => createHash('sha1').update(s).digest('hex');

export class RedisNetCluster {
  /**
   * @param redis an ioredis client
   * @param {{prefix?:string, radius?:number, extent?:number, maxZoom?:number,
   *           hysteresis?:number, readFrom?:object}} opts
   *        readFrom: an ioredis client pointed at a read replica. Queries are
   *        dispatched with EVALSHA_RO, which replicas accept and which also
   *        guarantees the query path can never write. Reads then cost the write
   *        primary nothing -- worth doing, because a wide query is the one
   *        operation here that can occupy Redis for milliseconds.
   *        maxPipeline: how many upserts may ride in one pipeline. Redis finishes
   *        a whole pipeline before serving anyone else, so this value IS the
   *        head-of-line delay every other client sees. Measured at 200k points:
   *        batch 1 -> 5.2k moves/s and 0.7ms p99 for others; batch 20 -> 15.5k
   *        and 1.7ms; batch 200 -> 18.8k and 11.1ms. 20-25 buys ~82% of peak
   *        throughput for a fraction of the stall, so that is the default.
   */
  constructor(redis, opts = {}) {
    this.redis = redis;
    this.reader = opts.readFrom || redis;
    this.prefix = opts.prefix ?? 'nc';
    this.radius = opts.radius ?? 40;
    this.extent = opts.extent ?? 512;
    this.maxZoom = opts.maxZoom ?? 16;
    this.hysteresis = opts.hysteresis ?? 0.25;
    this.maxPipeline = opts.maxPipeline ?? 25;
    this.idField = opts.idField ?? 'id';
    for (const [name, file] of [['ncUpsert', 'upsert.lua'], ['ncRemove', 'remove.lua'],
                                ['ncQuery', 'query.lua'], ['ncStats', 'stats.lua'],
                                ['ncRep', 'rep.lua']]) {
      if (!redis[name]) redis.defineCommand(name, { numberOfKeys: 0, lua: COMMON + '\n' + lua(file) });
    }
  }

  /**
   * Publish the geometry every pod must agree on. Safe to call from all of them:
   * the first writer wins and the rest verify they match, so a pod started with
   * a different `radius` fails loudly instead of silently corrupting the index.
   */
  async init() {
    const key = `${this.prefix}:cfg`;
    const want = { radius: this.radius, extent: this.extent, maxZoom: this.maxZoom, hyst: this.hysteresis };
    const set = await this.redis.hsetnx(key, 'radius', String(this.radius));
    if (set === 1) {
      await this.redis.hset(key, 'extent', String(this.extent), 'maxZoom', String(this.maxZoom),
                                 'hyst', String(this.hysteresis));
    } else {
      const have = await this.redis.hgetall(key);
      for (const [k, v] of Object.entries(want)) {
        if (Number(have[k]) !== v) {
          throw new Error(`netcluster: index at "${this.prefix}" was built with ${k}=${have[k]}, ` +
                          `this process wants ${v}. Use a different prefix or match the geometry.`);
        }
      }
    }
    return this;
  }

  upsert(id, lng, lat) {
    const [x, y] = project(lng, lat);
    return this.redis.ncUpsert(this.prefix, String(id), String(x), String(y));
  }

  /**
   * Bulk upsert, split into pipelines of `maxPipeline`. The split is the point:
   * one giant pipeline would monopolise the Redis thread for its whole duration
   * and stall every other client behind it.
   */
  async upsertMany(points) {
    const out = [];
    for (let i = 0; i < points.length; i += this.maxPipeline) {
      const chunk = points.slice(i, i + this.maxPipeline);
      const pipe = this.redis.pipeline();
      for (const p of chunk) {
        const [x, y] = project(p.lng, p.lat);
        pipe.ncUpsert(this.prefix, String(p.id), String(x), String(y));
      }
      const res = await pipe.exec();
      const err = res.find(([e]) => e);
      if (err) throw err[0];
      for (const [, v] of res) out.push(v);
    }
    return out;
  }

  /**
   * Ingest a GeoJSON FeatureCollection, an array of Features, or one Feature,
   * through `upsertMany`. Upserts rather than replaces, as everywhere here.
   *
   * @returns how many features were ingested.
   *
   * Reading rules are the in-process ones -- id from `feature.id` then
   * `properties[idField]`, Point geometry only, altitude ignored. The one
   * difference is that **`properties` are dropped**: this backend stores position
   * and structure in Redis and nothing else, so there is nowhere to put them and
   * the queries never return them. Keep them in your own store, keyed by id.
   */
  async load(data, options) {
    const [fs, label] = featuresOf(data);
    const skip = options !== undefined && options.onError === 'skip';
    const scratch = [0, 0, 0, undefined];
    const points = [];
    for (let i = 0; i < fs.length; i++) {
      if (skip) {
        try { readFeature(fs[i], this.idField, scratch, `${label}[${i}]`); } catch { continue; }
      } else {
        readFeature(fs[i], this.idField, scratch, `${label}[${i}]`);
      }
      points.push({ id: scratch[0], lng: scratch[1], lat: scratch[2] });
    }
    await this.upsertMany(points);
    return points.length;
  }

  remove(id) { return this.redis.ncRemove(this.prefix, String(id)); }

  /** Dispatch a read-only script, preferring the replica and never writing. */
  async _readScript(file, args) {
    const src = this._ro || (this._ro = {});
    if (!src[file]) src[file] = { body: COMMON + '\n' + lua(file) };
    const s = src[file];
    if (!s.sha) s.sha = sha1(s.body);
    try {
      return await this.reader.call('EVALSHA_RO', s.sha, '0', ...args);
    } catch (e) {
      if (!/NOSCRIPT/i.test(e.message)) throw e;
      return await this.reader.call('EVAL_RO', s.body, '0', ...args);
    }
  }

  /** @returns GeoJSON features, the same shape the in-process index returns */
  async getClusters(bbox, zoom, limit = 5000) {
    let [x0, y0] = project(bbox[0], bbox[3]);
    let [x1, y1] = project(bbox[2], bbox[1]);
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];
    const z = Math.max(0, Math.min(this.maxZoom, Math.floor(zoom)));
    const flat = await this._readScript('query.lua',
      [this.prefix, String(x0), String(y0), String(x1), String(y1), String(z), String(limit)]);
    const out = [];
    for (let i = 0; i < flat.length; i += 4) {
      const id = flat[i], count = Number(flat[i + 1]);
      const lng = Number(flat[i + 2]) / PREC * 360 - 180;
      const yy = Number(flat[i + 3]) / PREC;
      const lat = 360 * Math.atan(Math.exp((0.5 - yy) * 2 * Math.PI)) / Math.PI - 90;
      out.push(count === 1
        ? { type: 'Feature', id, properties: { id }, geometry: { type: 'Point', coordinates: [lng, lat] } }
        : { type: 'Feature', properties: { cluster: true, cluster_id: `${id}@${z}`, point_count: count,
              point_count_abbreviated: count >= 10000 ? `${Math.round(count / 1000)}k`
                                     : count >= 1000 ? `${Math.round(count / 100) / 10}k` : String(count) },
            geometry: { type: 'Point', coordinates: [lng, lat] } });
    }
    return out;
  }

  /**
   * Is a device with this id currently in the index?
   *
   * One EXISTS against the point hash. No script, so it needs no EVALSHA round
   * trip, runs happily on a read replica, and costs the write primary nothing.
   */
  async has(id) {
    return (await this.reader.exists(`${this.prefix}:p:${String(id)}`)) === 1;
  }

  async size() { return Number(await this.redis.get(`${this.prefix}:n`) || 0); }

  /** Which cluster is this device drawn as at `zoom`? */
  representative(id, zoom) { return this._readScript('rep.lua', [this.prefix, String(id), String(zoom)]); }

  /** Debug only: SCANs the keyspace, cost is O(keys). Do not call on a hot path. */
  async stats() {
    const r = await this.redis.ncStats(this.prefix);
    return { count: Number(r[0]), centersPerLevel: r.slice(1).map(Number) };
  }

  /** Drop the whole index. Uses SCAN + UNLINK so it never blocks Redis. */
  async drop() {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${this.prefix}:*`, 'COUNT', 1000);
      cursor = next;
      if (keys.length) await this.redis.unlink(...keys);
    } while (cursor !== '0');
  }
}
