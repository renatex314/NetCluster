// GeoJSON ingest: the reading rules, the errors they produce, and the promise
// that going in through GeoJSON builds exactly the index the flat API builds.
import { NetCluster } from '../src/netcluster.js';

let n = 0;
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const ok = (c, m) => { n++; if (!c) fail(m); };
const throws = (fn, re, m) => {
  n++;
  try { fn(); } catch (e) { if (!re.test(e.message)) fail(`${m}: message was ${JSON.stringify(e.message)}`); return; }
  fail(`${m}: did not throw`);
};
const pt = (id, lng, lat, props) => ({
  type: 'Feature', id, properties: props ?? null,
  geometry: { type: 'Point', coordinates: [lng, lat] },
});

// ------------------------------------------------------------ reading rules --
{
  const i = new NetCluster();
  ok(i.load({ type: 'FeatureCollection', features: [pt('a', 1, 2), pt('b', 3, 4)] }) === 2, 'FeatureCollection');
  ok(i.load([pt('c', 5, 6)]) === 1, 'bare array of Features');
  ok(i.load(pt('d', 7, 8)) === 1, 'a single Feature');
  ok(i.load({ features: [pt('e', 9, 10)] }) === 1, 'features array without a type');
  ok(i.size === 5, `expected 5 points, got ${i.size}`);
  ok(i.has('a') && i.has('e'), 'ids not registered');
  console.log('  ok load(): FeatureCollection, array, lone Feature');
}
{
  const i = new NetCluster();
  // id on the feature wins; properties.id is the fallback; idField renames it
  i.load([pt('onfeature', 1, 1, { id: 'inprops' })]);
  ok(i.has('onfeature') && !i.has('inprops'), 'feature.id must win over properties.id');
  i.load([{ type: 'Feature', properties: { id: 'fromprops' }, geometry: { type: 'Point', coordinates: [2, 2] } }]);
  ok(i.has('fromprops'), 'properties.id fallback');

  const j = new NetCluster({ idField: 'plate' });
  j.load([{ type: 'Feature', properties: { plate: 'ABC-1' }, geometry: { type: 'Point', coordinates: [3, 3] } }]);
  ok(j.has('ABC-1'), 'idField did not name the id property');
  console.log('  ok id: feature.id, then properties[idField]');
}
{
  const i = new NetCluster();
  // altitude is allowed by the spec and ignored by clustering
  i.load([{ type: 'Feature', id: 'alt', properties: null, geometry: { type: 'Point', coordinates: [10, 20, 3000] } }]);
  const [f] = i.getClusters([-180, -85, 180, 85], 16);
  ok(f.geometry.coordinates.length === 2, 'a third coordinate leaked into the output');
  ok(Math.abs(f.geometry.coordinates[0] - 10) < 1e-6 && Math.abs(f.geometry.coordinates[1] - 20) < 1e-6,
     `position round-tripped as ${f.geometry.coordinates}`);
  console.log('  ok coordinates: altitude ignored, lng/lat round-trip');
}
{
  // properties: null means "none", {} is stored, an object is kept by reference
  const i = new NetCluster();
  const props = { plate: 'ABC' };
  i.load([pt('withprops', 1, 1, props), pt('noprops', 2, 2)]);
  const byId = Object.fromEntries(i.toGeoJSON().features.map((f) => [f.id, f]));
  ok(byId.withprops.properties === props, 'properties were copied instead of referenced');
  ok(byId.noprops.properties.id === 'noprops', 'a feature with no properties should report its id');
  console.log('  ok properties: null vs object, retained by reference');
}
{
  // categories are read from properties, exactly as with insert()
  const i = new NetCluster({ categories: 3 });
  i.load([pt('x', 1, 1, { category: 2 }), pt('y', 1.0001, 1.0001, { category: 0 })]);
  ok(i.getClusters([-180, -85, 180, 85], 16, 2).map((f) => f.id).join() === 'x', 'category filter');
  console.log('  ok categories come from properties.category');
}

// ------------------------------------------------------------------ errors --
{
  const i = new NetCluster();
  throws(() => i.load([{ type: 'Feature', id: 'p', properties: null,
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [1, 0], [0, 0]]] } }]),
    /Polygon.*expected "Point"/s, 'a Polygon must be rejected, not centroided');
  throws(() => i.load([pt('a', 1, 1), { type: 'Feature', properties: null, geometry: null }]),
    /features\[1\].*null geometry/s, 'a null geometry must be rejected and name its index');
  throws(() => i.load([{ type: 'Feature', properties: null, geometry: { type: 'Point', coordinates: [1, 1] } }]),
    /has no id/, 'a feature with no id anywhere must be rejected');
  // Tokyo written the wrong way round: 139.69 is not a latitude. (A swap is only
  // detectable when it puts a longitude past +-90 into the latitude slot -- a
  // swapped Sao Paulo is two valid numbers and nothing can tell.)
  throws(() => i.load([pt('tokyo', 35.68, 139.69)]), /latitude 139\.69.*\[longitude, latitude\]/s,
    'swapped coordinates must be caught when they are out of range');
  throws(() => i.load([pt('a', 1, 'x')]), /non-numeric coordinates/, 'string coordinates');
  throws(() => i.load({ type: 'Feature', properties: null }), /no.*geometry/, 'missing geometry');
  throws(() => i.insertFeature({ type: 'FeatureCollection', features: [] }),
    /FeatureCollection.*Pass it to load/s, 'a FeatureCollection sent to insertFeature');
  throws(() => i.load({ type: 'Point', coordinates: [0, 0] }), /type "Point"/, 'a bare geometry sent to load');
  throws(() => i.load(null), /got null/, 'null');
  console.log('  ok errors name the offending feature and what to do about it');
}
{
  // onError: 'skip' ingests what parses
  const i = new NetCluster();
  const got = i.load([pt('a', 1, 1), { type: 'Feature', properties: null, geometry: null }, pt('c', 3, 3)],
                     { onError: 'skip' });
  ok(got === 2, `skip ingested ${got}, expected 2`);
  ok(i.has('a') && i.has('c') && i.size === 2, 'skip ingested the wrong features');
  console.log('  ok onError: skip drops bad features and keeps going');
}
{
  // the default is not transactional, and says so by leaving the prefix in
  const i = new NetCluster();
  try { i.load([pt('a', 1, 1), { type: 'Feature', properties: null, geometry: null }, pt('c', 3, 3)]); } catch { /* expected */ }
  ok(i.size === 1 && i.has('a'), `expected the prefix before the failure, got size ${i.size}`);
  console.log('  ok load() applies the prefix before a failure');
}

// ------------------------------------------------- identical to the flat API --
{
  let seed = 99;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  const N = 20_000;
  const pts = [];
  for (let k = 0; k < N; k++) {
    const b = [[-46.63, -23.55], [2.35, 48.85], [139.69, 35.68]][k % 3];
    pts.push([b[0] + (rnd() - 0.5) * 2, b[1] + (rnd() - 0.5) * 2]);
  }
  const flat = new NetCluster({ categories: 4 });
  const geo = new NetCluster({ categories: 4 });
  for (let k = 0; k < N; k++) flat.insert(`v${k}`, pts[k][0], pts[k][1], { category: k % 4 });
  geo.load({ type: 'FeatureCollection', features: pts.map((p, k) =>
    pt(`v${k}`, p[0], p[1], { category: k % 4 })) });

  ok(flat.size === geo.size, 'sizes differ');
  ok(flat.memoryBytes() === geo.memoryBytes(), `memory differs: ${flat.memoryBytes()} vs ${geo.memoryBytes()}`);
  for (let z = 0; z <= 16; z += 2) {
    for (const cat of [-1, 0, 3]) {
      const a = flat.getClusters([-180, -85, 180, 85], z, cat);
      const b = geo.getClusters([-180, -85, 180, 85], z, cat);
      ok(a.length === b.length, `z=${z} cat=${cat}: ${a.length} clusters vs ${b.length}`);
      const key = (f) => `${f.id ?? ''}|${f.properties.point_count ?? 1}|${f.geometry.coordinates.join(',')}`;
      const A = a.map(key).sort().join(';');
      const B = b.map(key).sort().join(';');
      ok(A === B, `z=${z} cat=${cat}: clusters differ between the flat and GeoJSON paths`);
    }
  }
  console.log(`  ok GeoJSON and flat ingest build the same index (${N} points, all zooms, filtered and not)`);
}

// ------------------------------------------------------ moving via GeoJSON --
{
  const i = new NetCluster();
  i.insertFeature(pt('m', 0, 0, { a: 1 }));
  i.moveToFeature(pt('m', 10, 10));
  const [f] = i.toGeoJSON().features;
  ok(Math.abs(f.geometry.coordinates[0] - 10) < 1e-6, 'moveToFeature did not move the point');
  ok(f.properties.a === 1, 'a Feature with null properties cleared the stored ones');
  i.moveToFeature(pt('m', 10, 10, { a: 2 }));
  ok(i.toGeoJSON().features[0].properties.a === 2, 'properties were not replaced');
  console.log('  ok moveToFeature: moves, and null properties leave stored ones alone');
}

console.log(`geojson: ${n} assertions ok`);
