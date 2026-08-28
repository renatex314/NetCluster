# NetCluster

[![npm](https://img.shields.io/npm/v/netcluster-js.svg)](https://www.npmjs.com/package/netcluster-js)
[![npm downloads](https://img.shields.io/npm/dm/netcluster-js.svg)](https://www.npmjs.com/package/netcluster-js)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![types included](https://img.shields.io/badge/types-included-blue.svg)](src/index.d.ts)
[![license](https://img.shields.io/npm/l/netcluster-js.svg)](LICENSE)
[![live demo](https://img.shields.io/badge/demo-live-orange.svg)](https://renatex314.github.io/NetCluster/demo/index.html)

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

**TypeScript declarations are bundled** — there is no `@types/netcluster-js` to install, and there shouldn't be. The core has **zero dependencies**. `ioredis` and `fastify` are optional peers, needed only if you use the Redis backend or the bundled HTTP server.

## Quick start — in-process

```js
import { NetCluster } from 'netcluster-js';

const index = new NetCluster({ radius: 40, maxZoom: 16 });

// index a fleet
for (let i = 0; i < 1000; i++) {
  index.insert(`vehicle-${i}`, -46.63 + Math.random() * 0.2, -23.55 + Math.random() * 0.2,
               { plate: `ABC-${i}` });
}

// a device reports a new position — ~1 µs, no rebuild
index.moveTo('vehicle-0', -46.64, -23.56);

// what to draw in this viewport at this zoom
const features = index.getClusters([-47, -24, -46, -23], 11);
const tile     = index.getTile(11, 758, 1161);

// drill into a cluster. A cluster id is read off a feature — a device id is NOT
// a cluster id, and passing one throws.
const clusterId = features.find(f => f.properties.cluster).properties.cluster_id;
index.getClusterExpansionZoom(clusterId);   // the zoom it splits at
index.getChildren(clusterId);               // its sub-clusters
index.getLeaves(clusterId, 10);             // the vehicles inside it

// which marker is this device drawn in? (supercluster has no equivalent)
index.representative('vehicle-0', 11);

// is this device registered?
index.has('vehicle-0');                     // true

// device goes offline
index.remove('vehicle-0');
index.has('vehicle-0');                     // false
```

Runnable version: [`examples/basic.js`](examples/basic.js).

`getClusters` returns GeoJSON features in supercluster's shape, so an existing frontend needs no changes. GeoJSON goes in as well as out — see [GeoJSON](#geojson).

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

Runnable version: [`examples/redis.js`](examples/redis.js).

The whole index lives in Redis and every mutation runs as a Lua script, because the invariants span keys — two pods writing concurrently would otherwise corrupt the structure permanently. See [`server/README.md`](server/README.md) for the architecture, the measured limits and the operational rules.

There's also a ready HTTP server:

```bash
REDIS_URL=redis://localhost:6379 node server/server.js
curl 'localhost:3000/tile/11/758/1161'
```

## Demo

**▶ [Live demo](https://renatex314.github.io/NetCluster/demo/index.html)** — a Leaflet
map with a moving fleet, clustered incrementally. Click a cluster to expand it, and
watch the µs-per-report counter while every vehicle moves.

To run it locally:

```bash
git clone https://github.com/renatex314/NetCluster && cd NetCluster
npm run demo          # then open http://localhost:8944/demo/index.html
```

[`demo/index.html`](demo/index.html) is a single file with no build step. It imports
the library as an ES module, so it needs to be served rather than opened from
`file://`.

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
| memory @ 500k | 127 MB | 289 MB |
| cluster count / radius | within 1% of supercluster at every zoom | — |

Stability: after **5,000,000 continuous moves with no rebuild**, quality stays within 1.2% of a freshly built index and throughput is flat. Update cost does not grow with local density — it *falls*, from 2.14 µs to 0.52 µs as density rises by 10⁶.

Reproduce with `npm run bench`.

## Filtering by a property

Declare the properties you filter on and which combinations a query may name. Every node then carries a running total per combination, so a filtered query reads a precomputed number instead of walking the subtree:

```js
const index = new NetCluster({
  dimensions: {
    client: { values: 40, multi: true },       // a vehicle may have several owners
    status: ['idle', 'enroute', 'loading'],
  },
  filters: [['client'], ['status'], ['client', 'status']],
});

index.insert('v1', lng, lat, { client: [1, 7, 22], status: 'enroute' });

index.getClusters(bbox, zoom, { client: 7 });                     // exact
index.getClusters(bbox, zoom, { client: 7, status: 'enroute' });  // exact
index.getClusters(bbox, zoom);                                    // everything
```

Filters **combine** (`client 7 AND enroute`), a device may hold **several values** for one dimension, and reporting it again with different values **re-files it** — even when it has not moved, which is exactly what a status change looks like. Counts and centroids are exact throughout.

**You declare how many values there can be, not what they are.** `client: { values: 40 }` is a *count* — indices `0..39`, nothing enumerated — while a list like `['idle', 'enroute']` names them so queries can use the names. An unused range costs nothing: declaring 100,000 possible clients over 50,000 devices measures 45 MB, because memory tracks the values that actually occur rather than the ones you allowed for. A value in range that nothing has reported returns an empty result, not an error.

The single-category spelling still works and costs what it always did:

```js
const index = new NetCluster({ categories: 5 });
index.insert('v1', lng, lat, { category: 3 });
index.getClusters(bbox, zoom, 3);
```

At 200k points a filtered query is 0.04–0.08 ms — faster than an unfiltered one, since a subtree holding none of the requested value is pruned outright. You pay on writes and in memory: each declared shape is a separate aggregate, so three shapes cost about three times one. Sizing, layouts and the 0–7% extra markers you get from filtering a shared tree are in [`docs/FILTERING.md`](docs/FILTERING.md).

What it still cannot do: substring search, ranges, `OR` across values, or anything read out of `properties`. (The server answers substrings with a scanning `?where=` query; this library has no equivalent — [resolve the text to ids](docs/FILTERING.md#searching-by-text) and ask about those.) Nor a field whose distinct values **never stop growing** — a per-trip id — since every shape holds a running total per combination per device per tree level, so values that never repeat give each device its own bucket and the aggregates become a second copy of the fleet. Those and [why pulling every point out and filtering yourself loses points](docs/FILTERING.md#do-not-enumerate-the-index) are covered there too.

The server takes this a step further: a dimension declared with a `capacity` interns arbitrary labels as they arrive, so ids that climb into the millions fit behind a ceiling of a few thousand. Here the count form covers the same ground whenever your values are integers within a known range.

## GeoJSON

GeoJSON goes both ways. Queries have always returned it; input works too:

```js
const index = new NetCluster();

// a FeatureCollection, an array of Features, or one Feature
index.load(await (await fetch('/fleet.geojson')).json());

index.insertFeature(feature);            // one, or
index.moveToFeature(feature);            // one that already exists

index.getClusters(bbox, 11);             // Feature[]
index.getFeatureCollection(bbox, 11);    // { type: 'FeatureCollection', features }
index.toGeoJSON();                       // every live point, unclustered
```

`getFeatureCollection` is the shape `map.getSource(id).setData()` and `L.geoJSON()` want.

**Reading rules.** The id comes from `feature.id`, where GeoJSON says it belongs,
falling back to `properties.id` — or `properties[idField]` if you set that option.
`properties` is kept as-is, so `properties.category` feeds the [category
filter](#filtering-by-a-property) exactly as it does on `insert`; `null` means "no
properties". A third coordinate is altitude, and is ignored. Anything that is not
a Point geometry is rejected rather than quietly reduced to a centroid, and every
error names the offending feature by index (`features[8123]`), because the
alternative is bisecting a 200 MB file.

`load` **upserts**. Loading twice leaves the union, newest position winning — it
does not discard what is already indexed. There is no "reload" here because there
is no rebuild, which is the whole point of the library.

**It does not retain what you hand it.** The Feature wrapper, its `geometry`
object and its `coordinates` array are read once and dropped; only `properties`
survives, because the flat path keeps that too. Queries build their result
features from the index's own arena rather than handing your objects back, so
nothing downstream needs the input to stay alive.

That is measurable. 500,000 points, resident after ingest with the parsed GeoJSON
released:

| ingested via | resident | vs flat |
|---|---|---|
| `insert(id, lng, lat)` | 127.4 MB | — |
| `load()`, `properties: null` | 128.3 MB | +0.9 MB |
| `load()`, keeping properties | 148.9 MB | +21.5 MB |

The first two rows agreeing is the claim: **ingesting through GeoJSON does not
make the index bigger.** A GeoJSON point is three nested objects and an array —
the Feature, its `geometry`, its `coordinates`, plus `properties` — and V8 charges
40–100+ bytes for each object shell before any of your data, so an index that held
onto them would cost several times what the same points cost through `insert`.

The third row is your data, not GeoJSON's packaging: 20.6 MB for 500,000 `{ id }`
objects, which `insert` retains identically when you pass it the same object. So
what reading GeoJSON saves you is the wrapper, and only the wrapper. If your
points already flow through the app as GeoJSON you pay to parse them regardless;
the question is whether you are still paying once the index is built.

Reading a Feature instead of taking flat arguments costs **+160 ns/point (7%)** on
ingest, and nothing afterwards.

Reproduce with `node --expose-gc bench/geojson.js`.

## Options

| option | default | |
|---|---|---|
| `radius` | `40` | cluster radius in screen pixels |
| `extent` | `512` | tile extent those pixels are measured against |
| `maxZoom` | `16` | finest level maintained; queries clamp to it, so points closer than the radius there (~44 m at the defaults) always return as a cluster |
| `minZoom` | `0` | coarsest zoom a query may ask for |
| `hysteresis` | `0.25` | how far an assignment stretches before a point is re-homed |
| `categories` | `0` | number of filter categories (0 = off); shorthand for a single `dimensions` entry |
| `categoryField` | `'category'` | which property holds the category index |
| `dimensions` | — | properties you can filter on, each with its values; `{ multi: true }` lets a device hold several |
| `filters` | one per dimension | which combinations of dimensions a query may name — this is what filtering costs |
| `maxCellsPerDevice` | shapes (×8 if any `multi`) | cap on how many combinations one device may occupy |
| `denseCells` | `32` | cell count at or below which aggregates use the faster dense layout |
| `idField` | `'id'` | which property holds the id, when a GeoJSON Feature has no `id` of its own |

The same options configure the Redis backend, which additionally takes `prefix`
and `maxPipeline`.

### Tuning

`radius` and `extent` are one knob in two parts: what matters is the ratio. At the
defaults a cluster is 40px across on a 512px tile, so `radius: 80, extent: 1024`
clusters identically.

**Too many markers, too cluttered** — raise `radius`. 60–80 gives noticeably
fewer, larger clusters. This is almost always the right dial, and the only one most
people need.

**Clusters break apart too early as you zoom in** — raise `maxZoom`. It is the
zoom at which clustering stops entirely. Hard-capped at 20: beyond that the
fixed-point cell resolution runs out and the constructor throws.

**Markers reshuffle distractingly while points move** — raise `hysteresis`. This is
the one people do not know they want. At 0 a point is re-homed the instant it
strictly violates its covering constraint, so a vehicle idling on a boundary
flickers between two clusters. At 0.25 the existing assignment survives 25% past
that, trading a slightly looser worst-case radius — `2(1+h)·r_z` instead of
`2·r_z` — for far fewer visible changes. Try 0.5 if churn is still visible; it also
costs less CPU, because fewer moves take the repair path.

**Filtering** — set `categories` to how many you have and `categoryField` to the
property holding the index. Update cost does not grow with the number of
categories: a point belongs to exactly one, so it touches exactly one slice per
level.

Geometry cannot change on a live index. On the Redis backend `init()` verifies that
every pod agrees and fails loudly if not — two processes disagreeing about what a
cluster means, while both believe they configured it, is the failure worth being
noisy about.

## Layout

```
src/            the index — zero dependencies
  netcluster.js   the hierarchy of nets
  cellhash.js     typed-array hash map
  geojson.js      GeoJSON reading, kept out of the hot path
server/         Redis backend — index in Redis, stateless Node
  lua/            the operations, atomic
  server.js       HTTP API (Fastify)
test/           invariants, API, GeoJSON, filtering, Redis integration
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
