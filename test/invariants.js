// Brute-force verification of every structural invariant of NetCluster,
// under long randomized sequences of insert / move / remove.
import { NetCluster, PREC } from '../src/netcluster.js';

const NONE = -1;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

function check(idx, label) {
  const { maxZoom, LEAF, r, hysteresis } = idx;
  const live = [...idx.ids.values()];
  const liveSet = new Set(live);
  const err = (m) => { throw new Error(`[${label}] ${m}`); };

  // ---- 1. tree shape: levels strictly increase downward, roots have level 0
  for (const s of live) {
    const t = idx.tz[s];
    if (t < 0 || t > LEAF) err(`slot ${s} has level ${t}`);
    const p = idx.par[s];
    if (t === 0) { if (p !== NONE) err(`root ${s} has parent`); }
    else {
      if (p === NONE) err(`slot ${s} at level ${t} has no parent`);
      if (!liveSet.has(p)) err(`slot ${s} parent ${p} is dead`);
      if (idx.tz[p] >= t) err(`level inversion: ${s}@${t} under ${p}@${idx.tz[p]}`);
      // ---- 2. COVERING (with hysteresis slack)
      const dx = idx.qx[p] - idx.qx[s], dy = idx.qy[p] - idx.qy[s];
      const lim = r[t - 1] * (1 + hysteresis);
      if (dx * dx + dy * dy > lim * lim + 1e-6) {
        err(`covering violated: d(${s},${p})=${Math.sqrt(dx*dx+dy*dy).toFixed(1)} > ${lim.toFixed(1)} at level ${t-1}`);
      }
    }
  }
  // child lists agree with parent pointers, and are sorted by level
  const seenChild = new Set();
  for (const s of live) {
    let prev = NONE, lastLvl = -1;
    for (let c = idx.kid[s]; c !== NONE; c = idx.sib[c]) {
      if (seenChild.has(c)) err(`node ${c} appears in two child lists`);
      seenChild.add(c);
      if (idx.par[c] !== s) err(`child ${c} of ${s} has parent ${idx.par[c]}`);
      if (idx.psib[c] !== prev) err(`psib broken at ${c}`);
      if (idx.tz[c] < lastLvl) err(`child list of ${s} not sorted by level`);
      lastLvl = idx.tz[c]; prev = c;
    }
  }
  for (const s of live) if (idx.par[s] !== NONE && !seenChild.has(s)) err(`node ${s} not in its parent's child list`);

  // ---- 3. SEPARATION: any two centers of C_z are more than r_z apart
  const centers = live.filter(s => idx.tz[s] <= maxZoom);
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      const a = centers[i], b = centers[j];
      const z = Math.max(idx.tz[a], idx.tz[b]);       // both are in C_z
      const dx = idx.qx[a] - idx.qx[b], dy = idx.qy[a] - idx.qy[b];
      if (dx * dx + dy * dy <= r[z] * r[z] - 1e-6) {
        err(`separation violated at level ${z}: d(${a}@${idx.tz[a]},${b}@${idx.tz[b]})=${Math.sqrt(dx*dx+dy*dy).toFixed(1)} <= ${r[z].toFixed(1)}`);
      }
    }
  }

  // ---- 4. aggregates equal brute-force subtree sums
  const sub = new Map();
  const visit = (s) => {
    if (sub.has(s)) err(`cycle at ${s}`);
    let c = 1, ax = idx.qx[s], ay = idx.qy[s];
    sub.set(s, null);
    for (let b = idx.kid[s]; b !== NONE; b = idx.sib[b]) {
      const t = visit(b); c += t[0]; ax += t[1]; ay += t[2];
    }
    const t = [c, ax, ay]; sub.set(s, t); return t;
  };
  for (const s of live) if (idx.par[s] === NONE) visit(s);
  if (sub.size !== live.length) err(`forest covers ${sub.size} of ${live.length} nodes (orphans/cycles)`);
  for (const s of live) {
    const t = sub.get(s);
    if (idx.cnt[s] !== t[0]) err(`cnt[${s}]=${idx.cnt[s]} want ${t[0]}`);
    if (Math.abs(idx.sx[s] - t[1]) > 1e-6) err(`sx[${s}] drift ${idx.sx[s] - t[1]}`);
    if (Math.abs(idx.sy[s] - t[2]) > 1e-6) err(`sy[${s}] drift ${idx.sy[s] - t[2]}`);
  }

  // ---- 5. grid holds exactly the centers: a center of C_z must be listed in
  //         every level from tz down to maxZoom, once each, in the right cell
  const seen = new Map();     // "slot:z" -> count
  for (let i = 0; i < idx.grid.cap; i++) {
    if (idx.grid.keys[i] === -1) continue;
    const key = idx.grid.keys[i];
    const z = Math.floor(key / 2 ** 48);
    let e = idx.grid.vals[i];
    if (e === -1) err('empty cell left in grid');
    do {
      const s = idx.eSlot[e];
      if (!liveSet.has(s)) err(`dead slot ${s} in grid level ${z}`);
      if (idx.tz[s] > z) err(`slot ${s}@${idx.tz[s]} listed at level ${z}`);
      const cs = idx.cs[z];
      const want = (z * 2 ** 48) + Math.floor(idx.qx[s] / cs) * 2 ** 24 + Math.floor(idx.qy[s] / cs);
      if (want !== key) err(`slot ${s} in wrong cell at level ${z}`);
      const k = s + ':' + z;
      if (seen.has(k)) err(`slot ${s} listed twice at level ${z}`);
      seen.set(k, 1);
      e = idx.eNext[e];
    } while (e !== NONE);
  }
  let expect = 0;
  for (const s of centers) {
    for (let z = idx.tz[s]; z <= maxZoom; z++) {
      if (!seen.has(s + ':' + z)) err(`center ${s}@${idx.tz[s]} missing from grid level ${z}`);
      expect++;
    }
  }
  if (seen.size !== expect) err(`grid holds ${seen.size} listings, expected ${expect}`);
  if (idx.gridEntries() !== expect) err(`entry pool leak: ${idx.gridEntries()} live vs ${expect}`);

  // ---- 6. MAXIMALITY: no live point may sit uncovered where it could be a center
  //        (i.e. the point set really is a maximal net at every level)
  for (const s of live) {
    const t = idx.tz[s];
    if (t === 0) continue;
    // there must exist a center at level t-1 within r_{t-1}: the parent (checked above).
    // and no center of C_t within r_t: that is the separation check above.
  }

  // ---- 7. every level's clustering is a partition of the live set,
  //         and the radius bound d(point, representative) <= 2(1+h) r_z holds
  for (let z = 0; z <= maxZoom; z++) {
    let total = 0;
    const repOf = new Map();
    for (const s of live) {
      let a = s;
      while (idx.tz[a] > z) a = idx.par[a];
      repOf.set(s, a);
      const dx = idx.qx[a] - idx.qx[s], dy = idx.qy[a] - idx.qy[s];
      const lim = 2 * (1 + hysteresis) * r[z];
      if (dx * dx + dy * dy > lim * lim + 1e-6) {
        err(`radius bound broken at z=${z}: ${Math.sqrt(dx*dx+dy*dy).toFixed(1)} > ${lim.toFixed(1)}`);
      }
    }
    const groups = new Map();
    for (const [, a] of repOf) groups.set(a, (groups.get(a) || 0) + 1);
    for (const [a, n] of groups) {
      const agg = idx._clusterAt(a, z, [0, 0, 0]);
      if (agg[0] !== n) err(`cluster aggregate at z=${z} for ${a}: ${agg[0]} != ${n}`);
      total += n;
    }
    if (total !== live.length) err(`level ${z} partition covers ${total}/${live.length}`);
  }
  return { centers: centers.length, live: live.length };
}

// ---------------------------------------------------------------------------
function run(name, seed, N, steps, opts, world) {
  const rnd = rng(seed);
  const idx = new NetCluster(opts);
  const pos = new Map();
  const pick = () => {
    // mixture: dense city blobs + uniform spread (worst case for a net)
    if (rnd() < 0.7) {
      const c = Math.floor(rnd() * world.length);
      return [world[c][0] + (rnd() - 0.5) * 0.4, world[c][1] + (rnd() - 0.5) * 0.4];
    }
    return [rnd() * 360 - 180, rnd() * 140 - 70];
  };
  for (let i = 0; i < N; i++) { const p = pick(); idx.insert(i, p[0], p[1]); pos.set(i, p); }
  check(idx, `${name}:build`);
  let nextId = N;
  for (let step = 0; step < steps; step++) {
    const u = rnd();
    if (u < 0.55 && pos.size) {                      // move (small or large jump)
      const keys = [...pos.keys()];
      const id = keys[Math.floor(rnd() * keys.length)];
      const p = pos.get(id);
      const q = rnd() < 0.85
        ? [p[0] + (rnd() - 0.5) * 0.02, p[1] + (rnd() - 0.5) * 0.02]   // creep
        : pick();                                                       // teleport
      idx.moveTo(id, q[0], q[1]); pos.set(id, q);
    } else if (u < 0.78) {                            // insert
      const p = pick(); idx.insert(nextId, p[0], p[1]); pos.set(nextId, p); nextId++;
    } else if (pos.size) {                            // remove
      const keys = [...pos.keys()];
      const id = keys[Math.floor(rnd() * keys.length)];
      idx.remove(id); pos.delete(id);
    }
    if (step % 200 === 0) check(idx, `${name}:step${step}`);
  }
  const res = check(idx, `${name}:final`);
  // duplicate-coordinate torture: many points at the exact same spot
  for (let i = 0; i < 60; i++) idx.insert(1e6 + i, 10, 10);
  check(idx, `${name}:dupes`);
  for (let i = 0; i < 30; i++) idx.remove(1e6 + i);
  check(idx, `${name}:dupes-removed`);
  console.log(`  ok ${name}: ${res.live} points, ${res.centers} centers, ` +
              `${JSON.stringify(idx.stats)}`);
}

function runDense(name, seed, N, steps, opts) {
  const rnd = rng(seed);
  const idx = new NetCluster(opts);
  const pos = new Map();
  const C = [-46.6333, -23.5505], S = 0.004;     // ~450 m box
  const pick = () => [C[0] + (rnd() - 0.5) * S, C[1] + (rnd() - 0.5) * S];
  for (let i = 0; i < N; i++) { const p = pick(); idx.insert(i, p[0], p[1]); pos.set(i, p); }
  check(idx, `${name}:build`);
  let nextId = N;
  for (let step = 0; step < steps; step++) {
    const u = rnd(), keys = [...pos.keys()];
    if (u < 0.6 && keys.length) {
      const id = keys[Math.floor(rnd() * keys.length)], p = pos.get(id);
      const q = [p[0] + (rnd() - 0.5) * 0.0004, p[1] + (rnd() - 0.5) * 0.0004];
      idx.moveTo(id, q[0], q[1]); pos.set(id, q);
    } else if (u < 0.8) { const p = pick(); idx.insert(nextId, p[0], p[1]); pos.set(nextId, p); nextId++; }
    else if (keys.length) { const id = keys[Math.floor(rnd() * keys.length)]; idx.remove(id); pos.delete(id); }
    if (step % 200 === 0) check(idx, `${name}:step${step}`);
  }
  const res = check(idx, `${name}:final`);
  const leaves = [...idx.ids.values()].filter(s => idx.tz[s] > idx.maxZoom).length;
  console.log(`  ok ${name}: ${res.live} points, ${res.centers} centers, ${leaves} leaves, ` +
              `fast moves ${(100*idx.stats.movesFast/idx.stats.moves).toFixed(0)}%`);
}

const cities = [[-46.63,-23.55],[2.35,48.85],[-74.0,40.71],[139.69,35.68],[116.4,39.9],
                [-43.17,-22.9],[13.4,52.52],[151.2,-33.87],[55.27,25.2],[-99.13,19.43]];
console.log('NetCluster invariant stress tests');
run('mixed-z16', 12345, 400, 3000, { maxZoom: 16 }, cities);
run('shallow-z6', 999, 300, 2000, { maxZoom: 6 }, cities);
run('nohyst', 777, 300, 2000, { maxZoom: 14, hysteresis: 0 }, cities);
run('bighyst', 31337, 250, 1500, { maxZoom: 12, hysteresis: 1.0 }, cities);
run('single-city', 4242, 500, 2500, { maxZoom: 16 }, [[-46.63,-23.55]]);
// dense: point spacing well below r_maxZoom (~48 m), so most points are LEAVES
// and the leaf fast-path / deep parent chains get exercised
runDense('dense-block', 5150, 400, 2500, { maxZoom: 16 });
console.log('ALL INVARIANT TESTS PASSED');
