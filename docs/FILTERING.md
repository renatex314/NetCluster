# Filtering by a property

You want "show only the trucks", or "only status = 3". Here is how it works and
what it costs.

## How to use it

Declare how many categories exist, tag each point with one, and pass the
category to the query:

```js
const index = new NetCluster({ categories: 5 });   // values 0..4

index.insert('v1', lng, lat, { category: 3 });

index.getClusters(bbox, zoom, 3);   // only category 3
index.getClusters(bbox, zoom);      // everything
```

Use `categoryField` if your property isn't called `category`.

## What it costs

Every node in the tree carries `(count, sumX, sumY)`. With K categories it
carries K of them. A point belongs to exactly one category, so it touches
exactly one slice — **the update cost does not grow with K**.

Measured at 200,000 points:

| categories | insert | move | remove | extra memory | filtered query |
|---|---|---|---|---|---|
| off | 1.94 µs | **1.81 µs** | 7.05 µs | 0 | — |
| 2 | 2.09 µs | **1.83 µs** | 7.64 µs | 8 MB | 0.065 ms |
| 8 | 2.16 µs | **1.91 µs** | 8.18 µs | 32 MB | 0.051 ms |
| 32 | 2.54 µs | **1.95 µs** | 10.54 µs | 128 MB | 0.036 ms |

Moves stay flat. Removal is the one path that pays for K, because re-homing an
orphaned child moves a whole subtree and that means all K slices — but it is a
cold path (3.3 re-homings per removal). A filtered query is *faster* than an
unfiltered one, since a subtree holding none of the requested category is
pruned outright.

The real cost is memory: **20 bytes per point per category**. Eight categories
over a million points is 160 MB; thirty-two is 640 MB. That, not marker count,
is what will force a design change.

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
  `category=3` is not the one you get unfiltered. Key tile caches on the filter,
  and don't persist "this cluster is expanded" UI state across a filter change.
- **Expand-on-click can look like a no-op.** `getClusterExpansionZoom` answers
  from the full tree, so you may zoom in and see the same single marker because
  the part it split into had no matching points. Either check the filtered count
  at the target zoom first, or zoom in by a fixed amount.

## When to use a separate index instead

Run one index per value (or one Redis `prefix` per value) when:

- memory pushes back — see the 20 bytes/point/category above;
- the filter is permanent rather than a user toggle;
- you need combinations (`type AND status`), where neither approach is good but
  separate indexes at least degrade predictably.

For a user-facing filter over a handful of values, the shared index is the right
call and nobody will notice the extra markers.
