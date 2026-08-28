// Filtered queries must be exact: the same answer as grouping the matching points
// by hand, under continuous insert/move/remove.
//
// The aggregate table is the one structure `verify()` cannot check -- it holds
// derived sums, not tree invariants -- and a filtered count that is quietly wrong
// is the worst thing this library could do, so it is checked here against brute
// force at every node, for every cell, after every batch of churn.
import { NetCluster } from '../src/netcluster.js';

let seed = 424242;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const cities = [[-46.63, -23.55], [2.35, 48.85], [-74.0, 40.71]];
const pick = () => { const c = cities[Math.floor(rnd() * cities.length)];
                     return [c[0] + (rnd() - 0.5) * 0.6, c[1] + (rnd() - 0.5) * 0.6]; };
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const WORLD = [-180, -85, 180, 85];

/**
 * One full pass: the table against brute force, then queries against brute force.
 *
 * `live` maps id -> { lng, lat, props }; `queries` is the list of filter objects
 * this schema can answer, each paired with the predicate that decides membership
 * independently of the index.
 */
function check(idx, live, queries, label) {
  const buf = new Int32Array(idx._mc);
  const cellsOf = (props) => {
    const n = idx.schema.cellsFor(props, buf);
    return Array.from(buf.subarray(0, n));
  };

  // 1. every stored (node, cell) triple equals the sum over that node's subtree
  const childrenOf = new Map();
  const roots = [];
  for (const id of live.keys()) {
    const s = idx.ids.get(id), p = idx.par[s];
    if (p === -1) roots.push(s);
    else { if (!childrenOf.has(p)) childrenOf.set(p, []); childrenOf.get(p).push(s); }
  }
  const idOf = new Map();
  for (const id of live.keys()) idOf.set(idx.ids.get(id), id);

  const visit = (s) => {
    const acc = new Map();                       // cell -> [count, sx, sy]
    const add = (cell, c, x, y) => {
      const t = acc.get(cell);
      if (t === undefined) acc.set(cell, [c, x, y]);
      else { t[0] += c; t[1] += x; t[2] += y; }
    };
    for (const cell of cellsOf(live.get(idOf.get(s)).props)) add(cell, 1, idx.qx[s], idx.qy[s]);
    for (const b of (childrenOf.get(s) || [])) {
      for (const [cell, t] of visit(b)) add(cell, t[0], t[1], t[2]);
    }
    // stored must equal computed, in both directions
    for (const [cell, t] of acc) {
      const e = idx._find(s, cell);
      if (e === -1) fail(`[${label}] node ${s} cell ${cell}: no entry, expected count ${t[0]}`);
      if (idx.acnt[e] !== t[0]) fail(`[${label}] node ${s} cell ${cell}: count ${idx.acnt[e]}, want ${t[0]}`);
      if (Math.abs(idx.asx[e] - t[1]) > 1e-6 || Math.abs(idx.asy[e] - t[2]) > 1e-6) {
        fail(`[${label}] node ${s} cell ${cell}: centroid sums drifted`);
      }
    }
    // and nothing else is held: a stale cell is how a filter starts over-counting
    let held = 0;
    if (idx.dense) {
      const C = idx.schema.cellCount;
      for (let k = 0; k < C; k++) {
        if (idx.acnt[s * C + k] === 0) continue;
        held++;
        if (!acc.has(k)) fail(`[${label}] node ${s} holds cell ${k} that no descendant is in`);
      }
    } else {
      for (let e = idx.cellHead[s]; e !== -1; e = idx.aNext[e]) {
        held++;
        if (!acc.has(idx.aCell[e])) fail(`[${label}] node ${s} holds cell ${idx.aCell[e]} that no descendant is in`);
        if (idx.acnt[e] === 0) fail(`[${label}] node ${s} keeps cell ${idx.aCell[e]} at count 0 instead of freeing it`);
      }
    }
    if (held !== acc.size) fail(`[${label}] node ${s} holds ${held} cells, ${acc.size} occur beneath it`);
    return acc;
  };
  for (const s of roots) visit(s);

  // 2. filtered queries equal a hand-made grouping, at every zoom
  for (let z = 0; z <= 16; z += 4) {
    for (const [filter, pred] of queries) {
      const matching = [...live.entries()].filter(([, v]) => pred(v.props));
      const got = idx.getClusters(WORLD, z, filter);
      const total = got.reduce((a, f) => a + (f.properties.point_count || 1), 0);
      if (total !== matching.length) {
        fail(`[${label}] z=${z} ${JSON.stringify(filter)}: query totals ${total}, ${matching.length} points match`);
      }
      // one marker per distinct representative among the matching points
      const reps = new Set(matching.map(([id]) => idx.representative(id, z)));
      if (got.length !== reps.size) {
        fail(`[${label}] z=${z} ${JSON.stringify(filter)}: ${got.length} markers, ${reps.size} distinct representatives`);
      }
      // a marker of one must name the device itself, not the cluster centre
      for (const f of got) {
        if (f.properties.point_count) continue;
        if (!live.has(f.id)) fail(`[${label}] singleton names ${f.id}, which is not live`);
        if (!pred(live.get(f.id).props)) {
          fail(`[${label}] z=${z} ${JSON.stringify(filter)}: singleton ${f.id} does not match the filter`);
        }
      }
    }
    // 3. an unfiltered query still agrees with the total
    const all = idx.getClusters(WORLD, z).reduce((a, f) => a + (f.properties.point_count || 1), 0);
    if (all !== live.size) fail(`[${label}] z=${z}: unfiltered totals ${all}, ${live.size} live`);
  }
}

function churn(idx, live, queries, label, steps, mk) {
  let nextId = 1e6;
  for (let step = 0; step < steps; step++) {
    const u = rnd(), keys = [...live.keys()];
    if (u < 0.4 && keys.length) {                       // move
      const id = keys[Math.floor(rnd() * keys.length)], v = live.get(id);
      const q = rnd() < 0.8 ? [v.lng + (rnd() - 0.5) * 0.05, v.lat + (rnd() - 0.5) * 0.05] : pick();
      idx.moveTo(id, q[0], q[1], v.props);
      live.set(id, { lng: q[0], lat: q[1], props: v.props });
    } else if (u < 0.6 && keys.length) {                // change values in place
      const id = keys[Math.floor(rnd() * keys.length)], v = live.get(id);
      const props = mk();
      idx.moveTo(id, v.lng, v.lat, props);
      live.set(id, { lng: v.lng, lat: v.lat, props });
    } else if (u < 0.82) {                              // insert
      const p = pick(), props = mk();
      idx.insert(nextId, p[0], p[1], props);
      live.set(nextId, { lng: p[0], lat: p[1], props }); nextId++;
    } else if (keys.length) {                           // remove
      const id = keys[Math.floor(rnd() * keys.length)];
      idx.remove(id); live.delete(id);
    }
    if (step % 400 === 0) check(idx, live, queries, `${label}/step${step}`);
  }
  check(idx, live, queries, `${label}/final`);
}

// ---------------------------------------------------------- one dimension --
// The 0.2 spelling, unchanged: `categories` plus a bare number.
// Both storage layouts are exercised: `denseCells: 0` forces the sparse table on
// a schema small enough to have been stored densely, so the two are checked
// against the same oracle rather than only where each happens to be chosen.
for (const denseCells of [32, 0]) {
  const K = 5, N = 1200;
  const idx = new NetCluster({ maxZoom: 16, categories: K, denseCells });
  if (idx.dense !== (denseCells > 0)) fail(`denseCells=${denseCells} picked the wrong layout`);
  const kind = idx.dense ? 'dense' : 'sparse';
  const live = new Map();
  const mk = () => ({ category: Math.floor(rnd() * K) });
  for (let i = 0; i < N; i++) {
    const p = pick(), props = mk();
    idx.insert(i, p[0], p[1], props);
    live.set(i, { lng: p[0], lat: p[1], props });
  }
  const queries = [];
  for (let c = 0; c < K; c++) queries.push([c, (props) => props.category === c]);
  check(idx, live, queries, `legacy/${kind}/build`);
  churn(idx, live, queries, `legacy/${kind}`, 1200, mk);
  console.log(`  ok legacy categories, ${kind} layout, under churn (${live.size} points)`);

  try { idx.insert('bad', 0, 0, { category: K }); fail('accepted an out-of-range category'); }
  catch (e) { if (!/outside/.test(e.message)) throw e; }
  console.log('  ok out-of-range category rejected');
}

// ------------------------------------------- several dimensions, combined --
for (const denseCells of [32, 0]) {
  const CLIENTS = 6, STATUS = ['idle', 'enroute', 'loading'];
  const idx = new NetCluster({
    maxZoom: 16,
    dimensions: { client: { values: CLIENTS, multi: true }, status: STATUS },
    filters: [['client'], ['status'], ['client', 'status']],
    denseCells,
  });
  const kind = idx.dense ? 'dense' : 'sparse';
  const live = new Map();
  const mk = () => {
    const n = 1 + Math.floor(rnd() * 3), set = new Set();
    while (set.size < n) set.add(Math.floor(rnd() * CLIENTS));
    return { client: [...set], status: STATUS[Math.floor(rnd() * STATUS.length)] };
  };
  for (let i = 0; i < 900; i++) {
    const p = pick(), props = mk();
    idx.insert(i, p[0], p[1], props);
    live.set(i, { lng: p[0], lat: p[1], props });
  }
  const queries = [];
  for (let c = 0; c < CLIENTS; c++) queries.push([{ client: c }, (p) => p.client.includes(c)]);
  for (const s of STATUS) queries.push([{ status: s }, (p) => p.status === s]);
  for (let c = 0; c < CLIENTS; c++) {
    for (const s of STATUS) {
      queries.push([{ client: c, status: s }, (p) => p.client.includes(c) && p.status === s]);
    }
  }
  check(idx, live, queries, `multi/${kind}/build`);
  churn(idx, live, queries, `multi/${kind}`, 900, mk);
  console.log(`  ok ${queries.length} filters over 2 dimensions (one multi-valued), ${kind} layout, under churn`);
}

// -------------------------------------------------------- value changes ----
// The failure this feature exists to fix: a parked vehicle whose status changes
// never moves, so every path that keyed off position used to miss it entirely.
{
  const idx = new NetCluster({ dimensions: { status: ['idle', 'enroute'] } });
  const n = (f) => idx.getClusters(WORLD, 16, f).reduce((a, x) => a + (x.properties.point_count || 1), 0);
  idx.insert('parked', -46.63, -23.55, { status: 'idle' });
  if (n({ status: 'idle' }) !== 1 || n({ status: 'enroute' }) !== 0) fail('initial status wrong');
  idx.moveTo('parked', -46.63, -23.55, { status: 'enroute' });        // identical position
  if (n({ status: 'idle' }) !== 0) fail('a status change left the device in its old filter');
  if (n({ status: 'enroute' }) !== 1) fail('a status change did not put the device in its new filter');
  idx.insert('parked', -46.63, -23.55, { status: 'idle' });           // insert routes to moveTo
  if (n({ status: 'idle' }) !== 1 || n({ status: 'enroute' }) !== 0) fail('re-insert did not re-file the device');
  console.log('  ok a stationary device changes filters when its values change');
}

// --------------------------------------------------------- co-located ------
// Devices sharing one coordinate cluster at every zoom, so a filter has to reach
// inside the cluster. This is the case that made a client-side filter drop a
// whole depot.
{
  const idx = new NetCluster({ maxZoom: 16, dimensions: { client: { values: 8, multi: true } } });
  for (let i = 0; i < 20; i++) idx.insert(`depot-${i}`, -46.6333, -23.5505, { client: [7] });
  for (let i = 0; i < 30; i++) idx.insert(`road-${i}`, -46.63 + (i - 15) * 0.02, -23.55 + (i - 15) * 0.02, { client: [7] });
  idx.insert('other', -46.6333, -23.5505, { client: [3] });
  const total = idx.getClusters(WORLD, 16, { client: 7 }).reduce((a, f) => a + (f.properties.point_count || 1), 0);
  if (total !== 50) fail(`co-located devices: filter found ${total} of 50`);
  const three = idx.getClusters(WORLD, 16, { client: 3 }).reduce((a, f) => a + (f.properties.point_count || 1), 0);
  if (three !== 1) fail(`co-located devices: client 3 found ${three} of 1`);
  console.log('  ok 20 devices sharing one coordinate are all reachable by filter');
}

// ------------------------------------------------------------- no leak -----
{
  const idx = new NetCluster({ dimensions: { client: { values: 8, multi: true } }, denseCells: 0 });
  const props = (i) => ({ client: [i % 8, (i * 3) % 8] });
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < 1500; i++) idx.insert(i, -46.6 + rnd(), -23.5 + rnd(), props(i));
    for (let i = 0; i < 1500; i++) idx.moveTo(i, -46.6 + rnd(), -23.5 + rnd(), props(i + r));
    for (let i = 0; i < 1500; i++) idx.remove(i);
    if (idx.aggEntries() !== 0) fail(`cycle ${r}: ${idx.aggEntries()} entries survived an empty index`);
  }
  console.log('  ok the table returns to zero entries after four full insert/move/remove cycles');
}

// ------------------------------------------------------ schema errors ------
{
  const bad = (fn, re, what) => {
    try { fn(); fail(`accepted ${what}`); }
    catch (e) { if (!re.test(e.message)) fail(`${what}: wrong message -- ${e.message}`); }
  };
  bad(() => new NetCluster({ categories: 3, dimensions: { a: 2 } }), /not both/, 'categories and dimensions together');
  bad(() => new NetCluster({ dimensions: { a: 2 }, filters: [['b']] }), /not a declared dimension/, 'a shape naming an unknown dimension');
  bad(() => new NetCluster({ dimensions: { a: 2 }, filters: [['a'], ['a']] }), /duplicate filter shape/, 'a duplicated shape');
  bad(() => new NetCluster({ dimensions: { a: ['x', 'x'] } }), /duplicate value labels/, 'duplicate labels');

  const idx = new NetCluster({ dimensions: { client: 4, status: ['idle', 'enroute'] } });
  idx.insert('v', 0, 0, { client: 1, status: 'idle' });
  bad(() => idx.getClusters(WORLD, 10, { client: 1, status: 'idle' }), /no declared filter shape/, 'an undeclared conjunction');
  bad(() => idx.getClusters(WORLD, 10, { nope: 1 }), /not a declared dimension/, 'an unknown dimension');
  bad(() => idx.getClusters(WORLD, 10, { status: 'gone' }), /not one of/, 'an unknown value');
  bad(() => idx.insert('w', 0, 0, { client: 9, status: 'idle' }), /outside \[0, 4\)/, 'an out-of-range value');
  bad(() => idx.insert('w', 0, 0, { client: [1, 2], status: 'idle' }), /not declared `multi: true`/, 'a list for a single-valued dimension');
  bad(() => idx.getClusters(WORLD, 10, { client: [1, 2] }), /takes one value/, 'a list in a filter');
  console.log('  ok undeclared shapes, unknown names and bad values are all rejected with a usable message');
}

console.log('FILTER TESTS PASSED');
