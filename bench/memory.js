// Run as: node --expose-gc bench/memory.js net|super
// One index per process: the only way to get an uncontaminated heap reading.
import { makeFleet, geojson } from './common.js';
const which = process.argv[2];
const N = 500_000;
const pts = makeFleet(N, 1);
global.gc(); global.gc();
const base = process.memoryUsage();
let idx;
if (which === 'net') {
  const { NetCluster } = await import('../src/netcluster.js');
  idx = new NetCluster({ radius: 40, maxZoom: 16 });
  for (let i = 0; i < N; i++) idx.insert(i, pts[i * 2], pts[i * 2 + 1]);
} else {
  const { default: Supercluster } = await import('supercluster');
  idx = new Supercluster({ radius: 40, maxZoom: 16, minZoom: 0 });
  idx.load(geojson(pts));            // supercluster retains this array (getLeaves needs it)
}
global.gc(); global.gc();
const after = process.memoryUsage();
const mb = (b) => (b / 1e6).toFixed(1);
console.log(`${which.padEnd(13)} heap ${mb(after.heapUsed - base.heapUsed).padStart(7)} MB` +
            `  external ${mb(after.external - base.external).padStart(6)} MB` +
            `  total ${mb((after.heapUsed + after.external) - (base.heapUsed + base.external)).padStart(7)} MB`);
if (idx.getClusters) idx.getClusters([-180, -85, 180, 85], 8);   // keep it alive past the measurement
