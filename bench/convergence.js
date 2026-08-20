// Rush hour: devices converge on venues. This is where "never revisit past
// decisions" heuristics fail -- they can split a crowd but never merge one --
// while a maintained net repairs itself.
import Supercluster from 'supercluster';
import { NetCluster, project, PREC } from '../src/netcluster.js';
import { GreedyIncremental } from './greedy.js';
import { makeFleet, makeMotion, step, geojson, table, fmt } from './common.js';

const N = 100_000;
const Z = 10, RADIUS = 40;
const rz = PREC * RADIUS / (512 * 2 ** Z);
const toPx = (d) => d / rz * RADIUS;
const VENUES = 20, SHARE = 0.4, TICKS = 60;

const pts = makeFleet(N, 1);
const mo = makeMotion(N, 2, 12);
const nc = new NetCluster({ radius: RADIUS, maxZoom: 16 });
const gr = new GreedyIncremental(Z, RADIUS);
for (let i = 0; i < N; i++) { nc.insert(i, pts[i * 2], pts[i * 2 + 1]); gr.insert(i, pts[i * 2], pts[i * 2 + 1]); }

// venue targets, drawn from existing device positions so they sit in populated areas
const venue = [];
for (let v = 0; v < VENUES; v++) { const i = Math.floor((v + 0.5) / VENUES * N); venue.push([pts[i * 2], pts[i * 2 + 1]]); }
const target = new Int32Array(N).fill(-1);
for (let i = 0; i < N; i++) if (i % Math.round(1 / SHARE) === 0) target[i] = i % VENUES;

const qx = new Float64Array(N), qy = new Float64Array(N);
const syncPos = () => { for (let i = 0; i < N; i++) { const [a, b] = project(pts[i * 2], pts[i * 2 + 1]); qx[i] = a; qy[i] = b; } };
const posOf = (i) => [qx[i], qy[i]];

function metrics(assign) {
  const cl = new Map();
  for (let i = 0; i < N; i++) {
    const k = assign(i); let c = cl.get(k); if (!c) cl.set(k, c = { n: 0, x: 0, y: 0 });
    c.n++; c.x += qx[i]; c.y += qy[i];
  }
  let sum = 0, max = 0;
  for (let i = 0; i < N; i++) {
    const c = cl.get(assign(i));
    const d = Math.hypot(qx[i] - c.x / c.n, qy[i] - c.y / c.n);
    sum += d; if (d > max) max = d;
  }
  // visual collisions: cluster markers drawn within half a radius of each other
  const cs = [...cl.values()].map(c => [c.x / c.n, c.y / c.n]);
  const g = new Map();
  for (const c of cs) { const k = Math.floor(c[0] / rz) * 1e7 + Math.floor(c[1] / rz); let b = g.get(k); if (!b) g.set(k, b = []); b.push(c); }
  let collide = 0, minSep = Infinity;
  for (const c of cs) {
    const gx = Math.floor(c[0] / rz), gy = Math.floor(c[1] / rz);
    let hit = false;
    for (let ax = -1; ax <= 1; ax++) for (let ay = -1; ay <= 1; ay++) {
      const b = g.get((gx + ax) * 1e7 + (gy + ay)); if (!b) continue;
      for (const o of b) {
        if (o === c) continue;
        const d = Math.hypot(c[0] - o[0], c[1] - o[1]);
        if (d < minSep) minSep = d;
        if (d < 0.5 * rz) hit = true;
      }
    }
    if (hit) collide++;
  }
  return { k: cl.size, mean: toPx(sum / N), max: toPx(max),
           collidePct: 100 * collide / cs.length, minSep: isFinite(minSep) ? toPx(minSep) : Infinity };
}

const rows = [];
function sample(label) {
  syncPos();
  const fresh = new NetCluster({ radius: RADIUS, maxZoom: 16 });
  for (let i = 0; i < N; i++) fresh.insert(i, pts[i * 2], pts[i * 2 + 1]);
  const sc = new Supercluster({ radius: RADIUS, maxZoom: 16, minZoom: 0 });
  sc.load(geojson(pts));
  const aS = new Int32Array(N).fill(-1); let cid = 0;
  for (const f of sc.getClusters([-180, -85, 180, 85], Z)) {
    const key = cid++;
    if (f.properties.cluster) for (const l of sc.getLeaves(f.properties.cluster_id, Infinity)) aS[l.properties.id] = key;
    else aS[f.properties.id] = key;
  }
  const m = {
    'netcluster (live)': metrics((i) => nc.representative(i, Z)),
    'netcluster (rebuilt)': metrics((i) => fresh.representative(i, Z)),
    'supercluster (rebuilt)': metrics((i) => aS[i]),
    'greedy (live)': metrics((i) => gr.representative(i)),
  };
  for (const [name, v] of Object.entries(m)) {
    rows.push({ phase: label, method: name, clusters: fmt(v.k, 0), 'mean px': fmt(v.mean),
                'max px': fmt(v.max), 'colliding %': fmt(v.collidePct, 1), 'min gap px': fmt(v.minSep, 1) });
  }
}
sample('t=0 (dispersed)');
for (let tick = 0; tick < TICKS; tick++) {
  for (let i = 0; i < N; i++) {
    if (target[i] >= 0) {                      // head for the venue, then mill around it
      const [tx, ty] = venue[target[i]];
      const dx = tx - pts[i * 2], dy = ty - pts[i * 2 + 1];
      const d = Math.hypot(dx, dy);
      const stepDeg = 0.02;
      if (d > 0.003) { pts[i * 2] += dx / d * Math.min(stepDeg, d); pts[i * 2 + 1] += dy / d * Math.min(stepDeg, d); }
      else { pts[i * 2] += (Math.random() - 0.5) * 0.002; pts[i * 2 + 1] += (Math.random() - 0.5) * 0.002; }
      nc.moveTo(i, pts[i * 2], pts[i * 2 + 1]);
      gr.moveTo(i, pts[i * 2], pts[i * 2 + 1]);
    } else {
      const [x, y] = step(pts, mo, i);
      nc.moveTo(i, x, y); gr.moveTo(i, x, y);
    }
  }
  if (tick === 19) sample('t=20 (converging)');
}
sample('t=60 (crowded)');
console.log('\n=== RUSH HOUR: 40% of 100,000 devices converge on 20 venues (zoom ' + Z + ') ===');
console.log('  colliding % : cluster markers drawn within 20px of another marker\n');
table(rows);
