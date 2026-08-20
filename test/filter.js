// Filtered queries must be exact: same answer as grouping the matching points by
// hand, under continuous insert/move/remove.
import { NetCluster } from '../src/netcluster.js';

const K = 5, N = 1200, STEPS = 1500;
let seed = 424242;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const cities = [[-46.63, -23.55], [2.35, 48.85], [-74.0, 40.71]];
const pick = () => { const c = cities[Math.floor(rnd() * cities.length)];
                     return [c[0] + (rnd() - 0.5) * 0.6, c[1] + (rnd() - 0.5) * 0.6]; };
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };

const idx = new NetCluster({ maxZoom: 16, categories: K });
const live = new Map();                       // id -> [lng, lat, category]
for (let i = 0; i < N; i++) {
  const p = pick(), c = Math.floor(rnd() * K);
  idx.insert(i, p[0], p[1], { category: c });
  live.set(i, [p[0], p[1], c]);
}
let nextId = N;

function check(label) {
  // 1. slices must sum to the totals, at every node
  for (const s of idx.ids.values()) {
    let c = 0, sx = 0, sy = 0;
    for (let k = 0; k < K; k++) { c += idx.ccnt[s * K + k]; sx += idx.csx[s * K + k]; sy += idx.csy[s * K + k]; }
    if (c !== idx.cnt[s]) fail(`[${label}] slice counts sum to ${c}, total says ${idx.cnt[s]}`);
    if (Math.abs(sx - idx.sx[s]) > 1e-6 || Math.abs(sy - idx.sy[s]) > 1e-6) {
      fail(`[${label}] slice sums drifted from the total at slot ${s}`);
    }
  }
  // 2. per-category subtree sums against brute force
  const childrenOf = new Map();
  for (const id of live.keys()) {
    const s = idx.ids.get(id), p = idx.par[s];
    if (p !== -1) { if (!childrenOf.has(p)) childrenOf.set(p, []); childrenOf.get(p).push(s); }
  }
  const visit = (s) => {
    const acc = new Array(K).fill(0);
    acc[idx.cat[s]] = 1;
    for (const b of (childrenOf.get(s) || [])) { const t = visit(b); for (let k = 0; k < K; k++) acc[k] += t[k]; }
    for (let k = 0; k < K; k++) {
      if (idx.ccnt[s * K + k] !== acc[k]) fail(`[${label}] ccnt[${s}][${k}]=${idx.ccnt[s * K + k]} want ${acc[k]}`);
    }
    return acc;
  };
  for (const id of live.keys()) { const s = idx.ids.get(id); if (idx.par[s] === -1) visit(s); }

  // 3. filtered queries equal a hand-made grouping, at every zoom
  for (let z = 0; z <= 16; z += 4) {
    const byCat = new Map();
    for (const [id, [, , c]] of live) {
      const rep = idx.representative(id, z);
      const key = c + ':' + rep;
      if (!byCat.has(key)) byCat.set(key, []);
      byCat.get(key).push(id);
    }
    for (let cat = 0; cat < K; cat++) {
      const got = idx.getClusters([-180, -85, 180, 85], z, cat);
      const total = got.reduce((a, f) => a + (f.properties.point_count || 1), 0);
      const want = [...live.values()].filter(v => v[2] === cat).length;
      if (total !== want) fail(`[${label}] z=${z} cat=${cat}: query totals ${total}, ${want} points have that category`);
      const wantClusters = [...byCat.keys()].filter(k => k.startsWith(cat + ':')).length;
      if (got.length !== wantClusters) fail(`[${label}] z=${z} cat=${cat}: ${got.length} clusters, expected ${wantClusters}`);
      // singletons must name the actual device, not the cluster centre
      for (const f of got) {
        if (f.properties.point_count) continue;
        const members = byCat.get(cat + ':' + idx.representative(f.id, z));
        if (!members || members.length !== 1 || members[0] !== f.id) {
          fail(`[${label}] z=${z} cat=${cat}: singleton reported device ${f.id} that is not the sole member`);
        }
        if (live.get(f.id)[2] !== cat) fail(`[${label}] singleton ${f.id} is category ${live.get(f.id)[2]}, asked for ${cat}`);
      }
    }
    // 4. the filtered counts must add up to the unfiltered ones
    const all = idx.getClusters([-180, -85, 180, 85], z);
    const allTotal = all.reduce((a, f) => a + (f.properties.point_count || 1), 0);
    let sum = 0;
    for (let cat = 0; cat < K; cat++) {
      sum += idx.getClusters([-180, -85, 180, 85], z, cat).reduce((a, f) => a + (f.properties.point_count || 1), 0);
    }
    if (sum !== allTotal) fail(`[${label}] z=${z}: categories sum to ${sum}, unfiltered says ${allTotal}`);
  }
}

check('build');
console.log(`  ok build: ${live.size} points across ${K} categories`);
for (let step = 0; step < STEPS; step++) {
  const u = rnd(), keys = [...live.keys()];
  if (u < 0.5 && keys.length) {
    const id = keys[Math.floor(rnd() * keys.length)], v = live.get(id);
    const q = rnd() < 0.8 ? [v[0] + (rnd() - 0.5) * 0.05, v[1] + (rnd() - 0.5) * 0.05] : pick();
    idx.moveTo(id, q[0], q[1]);
    live.set(id, [q[0], q[1], v[2]]);
  } else if (u < 0.78) {
    const p = pick(), c = Math.floor(rnd() * K);
    idx.insert(nextId, p[0], p[1], { category: c });
    live.set(nextId, [p[0], p[1], c]); nextId++;
  } else if (keys.length) {
    const id = keys[Math.floor(rnd() * keys.length)];
    idx.remove(id); live.delete(id);
  }
  if (step % 500 === 0) check('step' + step);
}
check('final');
console.log(`  ok ${STEPS} mixed ops: filtered counts, centroids and singletons all exact (${live.size} points)`);

// out-of-range category must be rejected, not silently corrupt the index
try { idx.insert('bad', 0, 0, { category: K }); fail('accepted an out-of-range category'); }
catch (e) { if (!/outside/.test(e.message)) throw e; }
console.log('  ok out-of-range category rejected');
console.log('FILTER TESTS PASSED');
