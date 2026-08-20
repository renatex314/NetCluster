// API-level checks: cluster expansion, children, leaves, and agreement between
// getClusters() and a brute-force assignment of every point to its level-z rep.
import { NetCluster } from '../src/netcluster.js';

let seed = 7;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const idx = new NetCluster({ maxZoom: 16 });
const N = 5000;
const pts = [];
for (let i = 0; i < N; i++) {
  const c = i % 3;
  const base = [[-46.63, -23.55], [2.35, 48.85], [-74.0, 40.71]][c];
  const p = [base[0] + (rnd() - 0.5) * 0.5, base[1] + (rnd() - 0.5) * 0.5];
  pts.push(p); idx.insert(i, p[0], p[1], { id: i });
}
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };

for (let z = 0; z <= 16; z++) {
  const cl = idx.getClusters([-180, -85, 180, 85], z);
  const total = cl.reduce((a, f) => a + (f.properties.point_count || 1), 0);
  if (total !== N) fail(`z=${z}: getClusters totals ${total}, expected ${N}`);
}
// expansion zoom must actually split the cluster
const top = idx.getClusters([-180, -85, 180, 85], 0);
if (top.length !== 3) fail(`expected 3 world clusters, got ${top.length}`);
for (const f of top) {
  if (!f.properties.cluster) continue;
  const ez = idx.getClusterExpansionZoom(f.properties.cluster_id);
  const kids = idx.getChildren(f.properties.cluster_id);
  if (kids.length < 2) fail(`cluster did not split at expansion zoom ${ez}`);
  const sum = kids.reduce((a, k) => a + (k.properties.point_count || 1), 0);
  if (sum !== f.properties.point_count) fail(`children sum ${sum} != parent ${f.properties.point_count}`);
  const leaves = idx.getLeaves(f.properties.cluster_id, 1e9);
  if (leaves.length !== f.properties.point_count) fail(`getLeaves ${leaves.length} != ${f.properties.point_count}`);
}
// viewport query must agree with a brute-force scan of the same box
for (let trial = 0; trial < 40; trial++) {
  const z = 3 + Math.floor(rnd() * 12);
  const c = pts[Math.floor(rnd() * N)];
  const w = 4 / 2 ** (z / 2);
  const bbox = [c[0] - w, c[1] - w, c[0] + w, c[1] + w];
  const got = new Set(idx.getClusters(bbox, z).map(f => f.properties.cluster_id ?? ('p' + f.id)));
  // brute force: every point's representative whose centroid falls in the box
  const reps = new Map();
  for (let i = 0; i < N; i++) {
    const s = idx.representative(i, z);
    reps.set(s, (reps.get(s) || 0) + 1);
  }
  let missing = 0;
  for (const [s] of reps) {
    const agg = idx._clusterAt(s, z, [0, 0, 0]);
    const mx = agg[1] / agg[0], my = agg[2] / agg[0];
    const [bx0, by0] = project2(bbox[0], bbox[3]), [bx1, by1] = project2(bbox[2], bbox[1]);
    if (mx >= Math.min(bx0, bx1) && mx <= Math.max(bx0, bx1) && my >= Math.min(by0, by1) && my <= Math.max(by0, by1)) {
      const key = agg[0] === 1 ? ('p' + idx.ext[s]) : (s * 32 + z);
      if (!got.has(key)) missing++;
    }
  }
  if (missing) fail(`viewport query missed ${missing} clusters (z=${z})`);
}
function project2(lng, lat) {
  const PREC = 2 ** 30;
  let x = (lng + 180) / 360; if (x < 0) x = 0; else if (x >= 1) x = 0.9999999;
  const s2 = Math.sin(lat * Math.PI / 180);
  let y = 0.5 - 0.25 * Math.log((1 + s2) / (1 - s2)) / Math.PI;
  if (y < 0) y = 0; else if (y >= 1) y = 0.9999999;
  return [Math.round(x * PREC), Math.round(y * PREC)];
}
// A bad cluster id must fail loudly. It used to index the typed arrays out of
// range, and `undefined !== NONE` kept the sibling walk spinning forever.
let leaked = 0;
for (const v of ['vehicle-1', undefined, null, {}, [], false, '', '   ', -5, 1e9, NaN, Infinity, [11]]) {
  for (const fn of ['getChildren', 'getLeaves', 'getClusterExpansionZoom']) {
    try { idx[fn](v); leaked++; console.error(`  ${fn} accepted ${JSON.stringify(v)}`); } catch (e) { /* expected */ }
  }
}
if (leaked) fail(`${leaked} invalid cluster ids were accepted instead of throwing`);
// valid ids keep working, as numbers and as strings (JSON round-trips)
{
  const c = idx.getClusters([-180, -85, 180, 85], 8).find(f => f.properties.cluster);
  const cid = c.properties.cluster_id;
  if (idx.getClusterExpansionZoom(cid) !== idx.getClusterExpansionZoom(String(cid))) {
    fail('numeric and string cluster ids disagree');
  }
  if (idx.getLeaves(cid, 1e9).length !== c.properties.point_count) fail('getLeaves count mismatch');
}
console.log('  ok cluster-id validation: 13 invalid inputs rejected, valid ids unaffected');

const t = idx.getTile(10, 366, 594);
console.log('  ok api: partitions, expansion zoom, children, leaves, viewport agreement' +
            (t ? `, tile(10/366/594)=${t.features.length} features` : ''));
console.log('API TESTS PASSED');
