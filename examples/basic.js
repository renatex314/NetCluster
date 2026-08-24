// A tour of the in-process index. Run it: node examples/basic.js
import { NetCluster } from '../src/index.js';          // 'netcluster-js' once installed

const index = new NetCluster({ radius: 40, maxZoom: 16 });

// --- a small fleet around Sao Paulo -----------------------------------------
const FLEET = 1000;
const pos = new Float64Array(FLEET * 2);
for (let i = 0; i < FLEET; i++) {
  pos[i * 2] = -46.63 + (Math.random() - 0.5) * 0.25;
  pos[i * 2 + 1] = -23.55 + (Math.random() - 0.5) * 0.25;
  index.insert(`vehicle-${i}`, pos[i * 2], pos[i * 2 + 1], { plate: `ABC-${String(i).padStart(4, '0')}` });
}
console.log(`${index.size} vehicles indexed`);

// --- devices report new positions. No rebuild, ever. -------------------------
index.moveTo('vehicle-0', -46.64, -23.56);          // this is the whole API for it

// Timed over many reports, because one call is mostly JIT warm-up. Each vehicle
// creeps a few metres, which is what a real position report looks like -- a
// random teleport across the whole city would cost several times more.
const STEP = 12 / 111320;                          // ~12 metres, in degrees
const report = (i) => {
  pos[i * 2] += (Math.random() - 0.5) * 2 * STEP;
  pos[i * 2 + 1] += (Math.random() - 0.5) * 2 * STEP;
  index.moveTo(`vehicle-${i}`, pos[i * 2], pos[i * 2 + 1]);
};
const MOVES = 50_000;
for (let i = 0; i < MOVES; i++) report(i % FLEET);   // warm up
const t0 = process.hrtime.bigint();
for (let i = 0; i < MOVES; i++) report(i % FLEET);
console.log(`${MOVES.toLocaleString()} position reports at ` +
            `${(Number(process.hrtime.bigint() - t0) / 1000 / MOVES).toFixed(2)} us each, no rebuild`);

// --- what to draw in this viewport, at this zoom ------------------------------
const bbox = [-47, -24, -46, -23];
for (const z of [8, 11, 14]) {
  const features = index.getClusters(bbox, z);
  const markers = features.filter(f => f.properties.cluster).length;
  const singles = features.length - markers;
  console.log(`zoom ${String(z).padStart(2)}: ${features.length} features ` +
              `(${markers} clusters + ${singles} single vehicles)`);
}

// --- drill into one cluster ---------------------------------------------------
// A cluster id is read off a feature. It is NOT a device id.
const clusters = index.getClusters(bbox, 11);
const cluster = clusters.find(f => f.properties.cluster);
const clusterId = cluster.properties.cluster_id;

console.log(`\ncluster ${clusterId} holds ${cluster.properties.point_count} vehicles`);
console.log(`  splits apart at zoom ${index.getClusterExpansionZoom(clusterId)}`);
console.log(`  breaks into ${index.getChildren(clusterId).length} sub-clusters`);
console.log(`  first 3 members: ${index.getLeaves(clusterId, 3).map(f => f.properties.plate).join(', ')}`);

// --- which marker is a given vehicle drawn inside? ----------------------------
console.log(`\nvehicle-0 is drawn inside cluster ${index.representative('vehicle-0', 11)} at zoom 11`);

// --- vector tile ---------------------------------------------------------------
const tile = index.getTile(11, 758, 1161);
console.log(`tile 11/758/1161: ${tile ? tile.features.length + ' features' : 'empty'}`);

// --- a device goes offline -----------------------------------------------------
index.remove('vehicle-0');
console.log(`\nafter removing vehicle-0: ${index.size} vehicles`);
console.log(`representative() now returns ${index.representative('vehicle-0', 11)} (gone)`);

// --- GeoJSON in, GeoJSON out ---------------------------------------------------
// Whatever is producing your points -- a .geojson file, a PostGIS query, a
// Mapbox source -- is probably already emitting this shape. load() reads it and
// drops the wrappers, so the index costs what it would have cost had you called
// insert() directly.
index.load({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 'van-1', properties: { plate: 'GEO-001' },
      geometry: { type: 'Point', coordinates: [-46.6400, -23.5600] } },
    // properties may be null, and a third coordinate is altitude: allowed by the
    // spec, ignored by clustering
    { type: 'Feature', id: 'van-2', properties: null,
      geometry: { type: 'Point', coordinates: [-46.6410, -23.5610, 720] } },
  ],
});
console.log(`\nafter load(): ${index.size} vehicles, van-1 registered = ${index.has('van-1')}`);

// getClusters returns bare features; getFeatureCollection wraps them, which is
// what map.getSource(id).setData() and L.geoJSON() want.
const fc = index.getFeatureCollection(bbox, 11);
console.log(`getFeatureCollection: ${fc.type} of ${fc.features.length} features`);
