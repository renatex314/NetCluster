// What GeoJSON ingest costs, and what it costs to keep.
//
//   node --expose-gc --max-old-space-size=8192 bench/geojson.js
//
// Two separate questions, and they have different answers:
//
//   ingest  -- how long does reading a Feature take, against passing the same
//              four values flat? (parent process, timed)
//   keep    -- once load() returns and you drop the parsed GeoJSON, how much of
//              it is still on the heap? (child processes, one index each, since
//              a shared heap cannot be attributed)
//
// The second is the one that matters: an index that quietly held onto every
// Feature you handed it would cost several times what the same points cost
// through insert(), and you would not find out until production.
import { makeFleet, geojson, table, fmt } from './common.js';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const N = 500_000;
const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------- child mode --
if (process.argv[2] === 'mem') {
  const which = process.argv[3];
  const pts = makeFleet(N, 1);
  for (let i = 0; i < 6; i++) global.gc();
  const base = process.memoryUsage();
  let idx;

  if (which === 'flat') {
    const { NetCluster } = await import('../src/netcluster.js');
    idx = new NetCluster({ radius: 40, maxZoom: 16 });
    for (let i = 0; i < N; i++) idx.insert(i, pts[i * 2], pts[i * 2 + 1]);
  } else if (which === 'geojson') {
    const { NetCluster } = await import('../src/netcluster.js');
    idx = new NetCluster({ radius: 40, maxZoom: 16 });
    let fs = geojson(pts);                       // properties: { id }
    idx.load(fs);
    fs = null;                                   // the wrappers are now garbage
  } else {                                       // 'geojson-lean'
    const { NetCluster } = await import('../src/netcluster.js');
    idx = new NetCluster({ radius: 40, maxZoom: 16 });
    let fs = new Array(N);                       // id on the feature, no properties
    for (let i = 0; i < N; i++) {
      fs[i] = { type: 'Feature', id: i, properties: null,
                geometry: { type: 'Point', coordinates: [pts[i * 2], pts[i * 2 + 1]] } };
    }
    idx.load(fs);
    fs = null;
  }

  // Pin both samples' contents explicitly. `pts` is a Float64Array of exactly
  // 8 MB, and whether V8 decides it is still reachable at the second sample is
  // a property of its scope analysis, not of the index -- an earlier version of
  // this file measured 0.9 MB or 8.9 MB for the same index depending on which
  // branch of an if/else the code took. Holding both live means `pts` appears
  // in `base` and in `after` and cancels, whatever V8 concludes.
  globalThis.__pin = [idx, pts];
  for (let i = 0; i < 6; i++) global.gc();
  const a = process.memoryUsage();
  process.stdout.write(String((a.heapUsed + a.external) - (base.heapUsed + base.external)));
  idx.getClusters([-180, -85, 180, 85], 8);      // and keep it alive past the read
  process.exit(0);
}

// --------------------------------------------------------------- parent mode --
const pts = makeFleet(N, 1);
const us = (t0, n) => Number(process.hrtime.bigint() - t0) / 1000 / n;

const { NetCluster } = await import('../src/netcluster.js');

// Build the Features up front and outside the timer: constructing them is the
// caller's cost in every one of these, and it is not what we are measuring.
const feats = geojson(pts);

let t = process.hrtime.bigint();
const flat = new NetCluster({ radius: 40, maxZoom: 16 });
for (let i = 0; i < N; i++) flat.insert(i, pts[i * 2], pts[i * 2 + 1], feats[i].properties);
const tFlat = us(t, N);

t = process.hrtime.bigint();
const geo = new NetCluster({ radius: 40, maxZoom: 16 });
geo.load(feats);
const tGeo = us(t, N);

if (flat.size !== geo.size) throw new Error(`built different indexes: ${flat.size} vs ${geo.size}`);

console.log('\n  ingest, per point (N = 500,000, properties on every feature)\n');
table([
  { path: 'netcluster insert(id, lng, lat, props)', 'us/point': fmt(tFlat, 2), total: `${fmt(tFlat * N / 1000)} ms` },
  { path: 'netcluster load(features)', 'us/point': fmt(tGeo, 2), total: `${fmt(tGeo * N / 1000)} ms` },
]);
console.log(`\n  reading a Feature instead of flat arguments: +${fmt((tGeo - tFlat) * 1000, 0)} ns/point ` +
            `(${fmt((tGeo / tFlat - 1) * 100, 0)}%)`);

const mem = (mode) =>
  Number(execFileSync(process.execPath,
    ['--expose-gc', '--max-old-space-size=8192', SELF, 'mem', mode], { encoding: 'utf8' }));

const mFlat = mem('flat');
const mGeo = mem('geojson');
const mLean = mem('geojson-lean');
const MB = (b) => `${fmt(b / 1e6)} MB`;

console.log('\n  resident after ingest, with the parsed GeoJSON dropped\n');
table([
  { index: 'netcluster, flat insert (no properties)', held: MB(mFlat), 'vs flat': '-' },
  { index: 'netcluster, load() with properties: null', held: MB(mLean), 'vs flat': MB(mLean - mFlat) },
  { index: 'netcluster, load() keeping properties', held: MB(mGeo), 'vs flat': MB(mGeo - mFlat) },
]);
console.log(`
  The Feature wrapper, its geometry object and its coordinates array are read and
  dropped, so load() costs the same to keep as insert() does -- the first two rows
  agree to within ${MB(mLean - mFlat)}. That is the whole claim: ingesting through
  GeoJSON does not make the index bigger.

  What the third row adds is properties, which is your data, not GeoJSON's
  packaging -- ${MB(mGeo - mLean)} for 500,000 { id } objects. The flat path
  retains it identically when you pass it to insert(). So what reading GeoJSON
  saves you is the wrapper, and only the wrapper.
`);
