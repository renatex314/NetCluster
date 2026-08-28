# Filtering by a property

You want "show only the trucks", or "only status = 3", or "client 7 **and**
en route". Here is how it works and what it costs.

## The short version

Declare the properties you filter on, declare which combinations a query may
name, and tag each point:

```js
const index = new NetCluster({
  dimensions: {
    client: { values: 40, multi: true },       // a vehicle may have several owners
    status: ['idle', 'enroute', 'loading'],    // named values
  },
  filters: [['client'], ['status'], ['client', 'status']],
});

index.insert('v1', lng, lat, { client: [1, 7, 22], status: 'enroute' });

index.getClusters(bbox, zoom, { client: 7 });                     // exact
index.getClusters(bbox, zoom, { client: 7, status: 'enroute' });  // exact
index.getClusters(bbox, zoom);                                    // everything
```

A **dimension** is a property you filter on. A **shape** is a combination you are
allowed to query. Counts and centroids are exact in every case, and a filtered
query costs about what an unfiltered one costs.

The single-category spelling still works, unchanged:

```js
const index = new NetCluster({ categories: 5 });
index.insert('v1', lng, lat, { category: 3 });
index.getClusters(bbox, zoom, 3);
```

## Using it, step by step

### 1. Declare what you filter on

Two things go in the config: the properties (`dimensions`) and the combinations a
query may name (`filters`).

```js
const index = new NetCluster({
  dimensions: {
    // a count means values are 0..n-1; `multi` lets one device hold several
    client: { values: 40, multi: true },
    // a list means named values, and the query can use the names
    status: ['idle', 'enroute', 'loading'],
  },
  filters: [['client'], ['status'], ['client', 'status']],
});
```

**You declare how many values there can be, not what they are.** A count is a
range: `{ values: 100000 }` accepts any index below it, nothing is enumerated, and
an unused range costs nothing — memory tracks the values that actually occur. On
the server the equivalent is `capacity`, which additionally interns arbitrary
labels, so auto-increment ids in the millions fit behind a ceiling of a few
thousand.

On the server the same thing is a `PUT`:

```bash
curl -X PUT localhost:8080/v1/collections/fleet -H 'content-type: application/json' -d '{
  "dimensions": [
    {"name": "client", "values": ["1", "7", "22"], "multi": true},
    {"name": "status", "values": ["idle", "enroute", "loading"]}
  ],
  "filters": [["client"], ["status"], ["client", "status"]]
}'
```

Pick `filters` from the filter controls your UI actually has. Every entry is a
separate running total, so listing combinations nobody asks for is pure cost.
Leaving `filters` out gives you each dimension on its own, which is the cheapest
useful setting.

### 2. Report values with the position

In the library, values live in the same properties object you already pass:

```js
index.insert('truck-1', lng, lat, { client: [7, 22], status: 'enroute' });
```

Through the server they ride in `dims` on the compact form:

```js
await fleet.report([
  { id: 'truck-1', lng, lat, dims: { client: ['7', '22'], status: 'enroute' } },
]);
```

or in `properties`, under the dimension's own name, in GeoJSON:

```json
{ "type": "Feature", "id": "truck-1",
  "geometry": { "type": "Point", "coordinates": [-46.63, -23.55] },
  "properties": { "client": [7, 22], "status": "enroute", "plate": "ABC1234" } }
```

`plate` there is ordinary payload: stored, handed back, never indexed.

**Positions and values move at different speeds, so they are reported
independently.** A report that carries no values leaves the device's alone:

```js
index.moveTo('truck-1', lng, lat);                              // just moved
index.moveTo('truck-1', lng, lat, { client: [7], status: 'idle' }); // and re-filed
```

That asymmetry matters in both directions. A GPS ping every two seconds must not
re-file the vehicle into whatever sits at value 0; and a status change **does not
move the vehicle**, so re-reporting it at its current position is the whole
update.

### 3. Query

```js
index.getClusters(bbox, zoom, { client: 7 });
index.getClusters(bbox, zoom, { client: 7, status: 'enroute' });
index.getClusters(bbox, zoom);                                   // everything
```

```
GET /v1/collections/fleet/clusters?bbox=…&zoom=12&f.client=7&f.status=enroute
```

The `f.` prefix keeps filter names clear of `bbox`, `zoom` and `cat`, so a
dimension called `zoom` is not a problem. Tiles take the same parameters.

A query names **one value per dimension**, and must name exactly the dimensions of
a declared shape. Anything else is an error listing what is declared — a filter
that silently matched nothing would look exactly like a fleet that had gone quiet.

### 4. Deleting the in-process filter

If you are coming from filtering in your own code, the shape of the change is:

```js
// before: pull the world, filter in Node, re-cluster the survivors
const all = await collection.getClusters({ bbox: WORLD, zoom: MAX + 1 });
const kept = all.features.filter(matchesVehicleFilter);
const clusters = new Supercluster(opts).load(kept).getClusters(bbox, zoom);

// after
const { features } = await collection.getClusters({
  bbox, zoom, filter: { client: clientId, status },
});
```

Three things go away with it: the whole-fleet transfer, the per-request index
rebuild, and a correctness bug — see [Do not enumerate the
index](#do-not-enumerate-the-index) for why the old path silently dropped every
vehicle parked in a depot.

What does **not** move into the index is text search. A plate box is a registry
lookup, not a map query; keep it in your own database and see [Searching by
text](#searching-by-text).

## Why shapes are declared

A conjunction cannot be assembled from its parts. Knowing how many points under a
node are `client 7`, and how many are `enroute`, tells you nothing about how many
are both — so an exact `client 7 AND enroute` needs its own running total, and
that total has to be maintained as points move.

Each shape you declare therefore gets its own aggregate, and that is what
filtering costs: `[['client'], ['status'], ['client','status']]` costs three times
what `[['client']]` does. Nothing is inferred from queries, deliberately — an
index whose memory depended on which page someone happened to open would be
impossible to size.

A query must name exactly the dimensions of a declared shape. Anything else
throws, listing what is declared. That is on purpose: the alternative is a filter
that quietly turns into a scan of the viewport, which looks fine in development
and falls over on a real fleet.

## What it costs

Measured at 200,000 points, one machine, same run.

**One dimension** — the old `categories`, behaving as it always did:

| categories | insert | move | remove | re-file | filtered query |
|---|---|---|---|---|---|
| off | 2.13 µs | 2.25 µs | 8.43 µs | — | — |
| 2 | 2.39 µs | 2.09 µs | 8.85 µs | 0.26 µs | 0.080 ms |
| 8 | 2.48 µs | 2.19 µs | 9.32 µs | 0.29 µs | 0.063 ms |
| 32 | 2.79 µs | 2.29 µs | 10.95 µs | 0.34 µs | 0.046 ms |

A filtered query is *faster* than an unfiltered one, because a subtree holding
none of the requested value is pruned outright.

**Several dimensions** — 40 clients and 4 statuses:

| filter | cells | entries | memory | insert | remove | query |
|---|---|---|---|---|---|---|
| one client | 40 | 0.56M | 101 MB | 3.31 µs | 23.2 µs | 0.069 ms |
| one client, multi-valued | 40 | 0.98M | 121 MB | 4.02 µs | 29.1 µs | 0.060 ms |
| client × status | 204 | 2.58M | 314 MB | 6.08 µs | 77.2 µs | 0.042 ms |

Reads stay in the same range throughout. Writes are where you pay: an insert
touches one cell per shape per level, so three shapes cost about three times one,
and a multi-valued dimension multiplies again.

### Sizing it

```
entries ≈ devices × tree-depth × shapes × values-per-device
```

Tree depth is about 7.5 at 200k points and grows very slowly. An entry is roughly
44 bytes in the sparse layout; the dense one costs 20 bytes per device per cell.

## Two layouts, chosen for you

Aggregates are stored one of two ways, and `index.dense` says which.

- **Dense** when the cell space is small (`denseCells`, default 32): a flat array
  indexed by `slot × cells + cell`. Fastest, and what the single-category path has
  always used. Costs 20 bytes per device per cell *whether or not the cell
  occurs*.
- **Sparse** otherwise: a hash keyed by `(node, cell)`, holding only the cells
  that actually occur.

That dense product is why sparse exists. A conjunction of three dimensions with
40, 8 and 5 values is 1,600 cells — 6.4 TB of mostly-zero slices at 200k devices.
A node's subtree holds at most as many distinct cells as it has points, so storing
only what occurs is bounded by the tree instead:

| client × status, 204 cells, 200k devices | memory | insert | remove | query |
|---|---|---|---|---|
| dense | 1,149 MB | 7.21 µs | 22.3 µs | 0.045 ms |
| sparse | 314 MB | 6.44 µs | 83.9 µs | 0.047 ms |

Sparse trades removal speed for a 3.7× smaller footprint; reads are a wash.
Removal is the one path that suffers, because re-homing a subtree touches every
cell it holds — a cold path, about 3.3 re-homings per removal, but not free. Set
`denseCells` yourself if you would rather buy speed with memory. Results are
identical either way, which is worth testing both ways and we do.

## What re-filing costs

[Step 2](#2-report-values-with-the-position) covers the semantics; this is the
price. Re-filing a device costs 0.26–0.34 µs with one dimension, and about 6.7 µs
across three shapes with a multi-valued dimension — it walks the device's ancestor
chain once to subtract its old cells and once to add its new ones, so it scales
with tree depth and with how many cells the device occupies, not with fleet size.

A device inserted with no values at all takes value 0 in every dimension, which is
what a missing `category` has always meant. Declare an explicit `'unassigned'`
label if that distinction matters to you.

## What it still cannot do

The filter is exact matching on values declared up front. It cannot express:

| you want | why not | do this instead |
|---|---|---|
| `plate CONTAINS "abc"` | a substring match has nothing to keep a running count of, so it cannot be an aggregate | scan for it: the server has `?where=plate~abc`, see [Searching by text](#searching-by-text) |
| `speed > 80` | ranges are not values | bucket it: a dimension per speed band |
| `client 7 OR client 9` | a query names one value per dimension | two queries, or a dimension whose values are the groups you actually ask about |
| a field whose values never repeat | a per-trip id gives every device its own cell, so the aggregates become a second copy of the fleet and any ceiling fills | it is a lookup, not a map filter — see [Searching by text](#searching-by-text) |
| anything in `properties` | `properties` are opaque payload, never indexed | make it a dimension if it has few values |

## Do not enumerate the index

The tempting workaround for a filter the index cannot express is to pull every
point out at maximum zoom, filter in your own code, and re-cluster the survivors:

```js
// WRONG -- this does not return every point
const all = index.getClusters(WORLD_BBOX, maxZoom + 1);
```

**It loses points.** Zoom is clamped to `maxZoom`, and at `maxZoom` the cluster
radius is small but not zero, so points closer together than that radius still
come back as a cluster. A cluster feature has no `properties` of yours and no
device id, so a predicate reading `properties.plate` silently skips every point
inside it.

Measured against the server: 50 vehicles, 20 of them parked in one depot, queried
at `zoom=17` with `max_zoom=16`.

```
features returned:   31   (not 50)
one of them:         {"cluster": true, "point_count": 20}
filter clientId=7:   30 vehicles found, of 50
filter plate~"abc":  0 found, of the 20 in the depot
```

Every vehicle in that yard vanishes from the filtered view. This is worst exactly
where fleets are densest — depots, ferries, a jam — and it fails silently, so it
reads as "the map is a bit sparse" rather than as a bug.

It is also the slowest thing you can do. Serialising a fleet, shipping it and
reparsing it costs far more than any clustering:

| 200,000 vehicles, per request | |
|---|---|
| serialise every point as GeoJSON | 32 ms |
| `JSON.parse` in Node | 109 ms |
| the filter predicate itself | 8 ms |
| rebuild a client-side cluster index | 63 ms |
| **total, before 36 MB crosses the network** | **~210 ms** |
| a native filtered query instead | **0.04–0.08 ms** |

If you need the members of a cluster, ask for them: `getLeaves(cluster_id)`, or
`GET /v1/collections/{name}/clusters/{id}/leaves`.

## Searching by text

A substring cannot be an aggregate — there is nothing to keep a running count of —
so it is answered by scanning instead. **The server does this natively**; declare
which fields may be searched and they are extracted from `props` at ingest:

```bash
curl -X PUT localhost:8080/v1/collections/fleet -H 'content-type: application/json' \
  -d '{"text": ["plate"]}'

curl 'localhost:8080/v1/collections/fleet/clusters?bbox=…&zoom=12&where=plate~abc'
```

The survivors are grouped into exactly the markers an unfiltered query would draw,
so counts and centroids stay exact and two matching vehicles in the same yard come
back as one marker of 2. It costs **`O(devices)`, not `O(markers)`** — about 1.5 ms
over a 180,000-device fleet, against a declared filter that reads one number per
node however large the fleet grows. Use a dimension whenever the values can be
declared; keep `where` for the search box.

**This library has no equivalent.** In-process, do it the other way round: resolve
the text to ids wherever it already lives and ask the index about those.

```js
const ids = await db.vehiclesMatchingPlate(q);                 // a few rows
const pins = ids.map((id) => index.representative(id, zoom));
```

A text search is selective by nature — a handful of matches out of a fleet — so
there is usually nothing left to cluster; draw them as individual pins.

## The caveat, in plain terms

When you filter, the map does not re-group your points. It keeps the groups it
already made from *all* of them and counts the matching ones inside each.

Say you have 1,000 cars and 20 trucks on screen. The groups were decided using
all 1,020 vehicles. Filter to trucks, and two trucks that landed in
*neighbouring* groups stay in neighbouring groups — so you see two pins saying
"1" where a truck-only index might have drawn one pin saying "2".

**Measured: 0–7% more markers**, and it does not get worse as the filter gets
more selective:

| filter passes | zoom 8 | zoom 10 | zoom 12 | zoom 14 |
|---|---|---|---|---|
| 25% of points | +1.1% | +2.8% | +2.3% | 0% |
| 6.3% | +1.4% | +6.9% | +1.0% | 0% |
| 1.6% | +6.0% | +5.8% | +0.5% | 0% |

It cannot blow up because both the shared and the dedicated index produce a set
of markers that is `r_z`-separated over the same points, so their sizes are
within a constant factor.

### What stays exact

- The number on a marker is exact — "7" means 7 matching points.
- The marker sits at the centroid of those 7, not of the unfiltered group.
- Markers never overlap and nothing is drawn in the wrong place.

### Three things that can trip you up

- **Don't assert an exact marker count in tests.** Comparing against an index
  built only from matching points will differ by a few percent. Assert on point
  totals instead — those always match.
- **Cluster ids are not stable across filters.** The id you get with
  `{ client: 7 }` is not the one you get unfiltered. Key tile caches on the
  filter, and don't persist "this cluster is expanded" UI state across a filter
  change.
- **Expand-on-click can look like a no-op.** `getClusterExpansionZoom` answers
  from the full tree, so you may zoom in and see the same single marker because
  the part it split into had no matching points. Either check the filtered count
  at the target zoom first, or zoom in by a fixed amount.

## When to use a separate index instead

Run one index per value (or one Redis `prefix` per value) when:

- memory pushes back — see the sizing formula above;
- the filter is permanent rather than a user toggle;
- you want an authorization boundary as well as a filter, so a query *cannot*
  reach another tenant's vehicles rather than merely not asking for them.

That last one is the honest reason to still split by client even though a
multi-valued dimension can now express it. A filter is a question; a separate
collection is a wall.

For a user-facing filter over a handful of values, one index is the right call and
nobody will notice the extra markers.
