# NetCluster

Geospatial point clustering for maps, like [supercluster](https://github.com/mapbox/supercluster) — except you can **move a point without rebuilding the index**.

```
supercluster:  one device moved  →  reload 500k points  →  ~850 ms
netcluster:    one device moved  →  ~2 µs
```

Same clustering quality (measured within 1% at every zoom), same read API, but the index is fully dynamic: insert, move and remove are O(log Δ) and independent of how many points you have.

Use it standalone in one Node process, or put the whole index in Redis and run stateless pods. Both are in this repo, and they produce **bit-identical output**.

---

## Why

Supercluster builds a static KD-tree per zoom level. It's excellent, and it's immutable by design — [the request for incremental updates is open since 2016](https://github.com/mapbox/supercluster/issues/19). If your points move (vehicles, deliveries, people), you either rebuild the whole index on a timer or you fall back to fixed-grid bucketing and accept the boundary artefacts.

NetCluster maintains a **hierarchy of nets** (a cover tree over Web Mercator) whose invariants are repaired locally on every update. Nothing is ever recomputed globally.

## Install

```bash
npm install netcluster-js
```

The core has **zero dependencies**. `ioredis` and `fastify` are optional peers, needed only if you use the Redis backend or the bundled HTTP server.

## Quick start — in-process

```js
import { NetCluster } from 'netcluster-js';

const index = new NetCluster({ radius: 40, maxZoom: 16 });

index.insert('vehicle-1', -46.63, -23.55, { plate: 'ABC-1234' });
index.moveTo('vehicle-1', -46.64, -23.56);   // ~2 µs, no rebuild
index.remove('vehicle-1');

// read API matches supercluster
const clusters = index.getClusters([-47, -24, -46, -23], 11);
const tile     = index.getTile(11, 758, 1161);
const children = index.getChildren(clusterId);
const leaves   = index.getLeaves(clusterId, 10);
const zoom     = index.getClusterExpansionZoom(clusterId);

// plus one supercluster doesn't have:
const marker   = index.representative('vehicle-1', 11);  // which cluster is it drawn in
```

`getClusters` returns GeoJSON features in supercluster's shape, so an existing frontend needs no changes.

## Quick start — Redis, stateless pods

```js
import Redis from 'ioredis';
import { RedisNetCluster } from 'netcluster-js/redis';

const redis  = new Redis(process.env.REDIS_URL);
const reader = new Redis(process.env.REDIS_READ_URL);      // optional replica

const index = new RedisNetCluster(redis, { readFrom: reader, radius: 40, maxZoom: 16 });
await index.init();

await index.upsert('vehicle-1', -46.63, -23.55);           // insert and move are one call
await index.upsertMany([{ id: 'v2', lng: -46.6, lat: -23.5 }, /* … */]);
await index.getClusters([-47, -24, -46, -23], 11);
```

The whole index lives in Redis and every mutation runs as a Lua script, because the invariants span keys — two pods writing concurrently would otherwise corrupt the structure permanently. See [`server/README.md`](server/README.md) for the architecture, the measured limits and the operational rules.

There's also a ready HTTP server:

```bash
REDIS_URL=redis://localhost:6379 node server/server.js
curl 'localhost:3000/tile/11/758/1161'
```

## Which one should you use

| | in-process | Redis |
|---|---|---|
| write throughput | **671,000 moves/s** | ~16,000 moves/s |
| move latency | 2 µs | 64 µs (pipelined) |
| processes | one writer | any number, stateless |
| survives a restart | rebuild from your source of truth (177 ms / 100k) | state is already in Redis |
| extra moving parts | none | Redis primary (+ replica for reads) |

Start in-process. Move to Redis when you need many writer processes more than you need throughput — the ceiling is Redis's single thread executing the scripts, and it does not improve with more connections.

## What it guarantees

For every zoom level `z`, at every moment, with no rebuild step:

- **Cluster radius** — every point is within `2·r_z` of the marker it's drawn as.
- **Separation** — two markers are never closer than `r_z`, so they don't overlap.
- **Nesting** — the levels are a strict refinement of each other, so expanding a cluster on zoom is exact rather than recomputed.

`r_z` is `radius` screen pixels at zoom `z` — the same scale supercluster uses.

These are the invariants of a hierarchy of nets ([Gao, Guibas & Nguyen 2004](http://graphics.stanford.edu/~jgao/spanner_journal.pdf); [Schmidt & Sohler 2019](https://arxiv.org/abs/1908.02645)), and they're checked by brute force in the test suite — pairwise separation, covering, aggregates against explicit subtree sums, and the per-level partition, over thousands of mixed operations.

## Measured

500,000 points, one machine, against supercluster on identical data:

| | netcluster | supercluster |
|---|---|---|
| **move one point** | **2.09 µs** | ~850 ms (full reload) |
| insert / remove one point | 2.07 µs / 7.8 µs | ~850 ms |
| build 100k | 177 ms | 182 ms |
| viewport query, z10 @ 1M | 0.023 ms | 0.021 ms |
| memory @ 500k | 119 MB | 289 MB |
| cluster count / radius | within 1% of supercluster at every zoom | — |

Stability: after **5,000,000 continuous moves with no rebuild**, quality stays within 1.2% of a freshly built index and throughput is flat. Update cost does not grow with local density — it *falls*, from 2.14 µs to 0.52 µs as density rises by 10⁶.

Reproduce with `npm run bench`.

## Filtering by a property

Declare the categories up front and every node carries per-category aggregates. A point belongs to one category, so **update cost stays flat in K**:

```js
const index = new NetCluster({ categories: 5 });
index.insert('v1', lng, lat, { category: 3 });

index.getClusters(bbox, zoom, 3);   // only category 3 — counts and centroids exact
index.getClusters(bbox, zoom);      // everything
```

Costs 20 bytes per point per category. Counts and centroids are exact; you get 0–7% more markers than an index built only from the matching points, because the tree was shaped by all of them. Details and the trade-off in [`docs/FILTERING.md`](docs/FILTERING.md).

## Options

| option | default | |
|---|---|---|
| `radius` | `40` | cluster radius in screen pixels |
| `maxZoom` | `16` | finest level maintained |
| `extent` | `512` | tile extent |
| `hysteresis` | `0.25` | how far an assignment stretches before a point is re-homed; higher = fewer visible marker changes, larger worst-case radius |
| `categories` | `0` | number of filter categories (0 = off) |

## Layout

```
src/            the index — zero dependencies
  netcluster.js   the hierarchy of nets
  cellhash.js     typed-array hash map
server/         Redis backend — index in Redis, stateless Node
  lua/            the operations, atomic
  server.js       HTTP API (Fastify)
test/           invariants, API, filtering, Redis integration
bench/          every measurement quoted above
docs/           the research this came from, and the original brief
```

## Background

This started as a research question: does anything satisfy incremental updates, real geometric quality, and no rebuild — all three at once? The answer, the literature, the algorithm and the full measurements are written up in [`docs/`](docs/) — including the [original brief](docs/BRIEF.md) that prompted it, and a [summary in Portuguese](docs/SOLUCAO.md).

Short version: the structure has been in the computational geometry literature since 2001–2006 under names like *discrete center hierarchy*, *net-tree* and *cover tree*. It never reached the map-visualisation ecosystem, which is why everyone rebuilds or buckets into a grid.

## Tests

```bash
npm test                                                   # core
redis-server --port 6399 --save '' --daemonize yes
REDIS_PORT=6399 npm run test:redis                         # Redis backend
```

The Redis suite runs the same operation sequence through both implementations and asserts the resulting clustering is **identical device by device at every zoom**, then checks that 8 concurrent writers break no invariant and that killing a pod mid-write leaves the index consistent.

## License

MIT
