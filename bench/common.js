// Shared data generation: a synthetic but realistic moving fleet.
//
// Population: metro areas with power-law sizes and gaussian density, plus a
// rural/highway tail. Motion: per-device velocity with small random turns
// (a road-like random walk), occasional GPS jumps and re-spawns.

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

export const METRO = [
  [-46.63, -23.55, 1.0], [-43.17, -22.91, 0.55], [-47.93, -15.78, 0.3],
  [-38.52, -12.97, 0.25], [-49.27, -25.43, 0.25], [-51.23, -30.03, 0.22],
  [-34.88, -8.06, 0.2], [-60.02, -3.10, 0.15], [-38.54, -3.72, 0.18],
  [-43.94, -19.92, 0.3], [-48.55, -27.60, 0.12], [-54.62, -20.44, 0.1],
  [-35.21, -5.79, 0.1], [-67.81, -9.97, 0.05], [-44.30, -2.53, 0.09],
];

function gauss(rnd) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** @returns {Float64Array} [lng, lat, ...] of length 2N */
export function makeFleet(n, seed = 1) {
  const rnd = rng(seed);
  const total = METRO.reduce((a, m) => a + m[2], 0);
  const pts = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    let lng, lat;
    if (rnd() < 0.88) {
      let r = rnd() * total, k = 0;
      while (k < METRO.length - 1 && (r -= METRO[k][2]) > 0) k++;
      const [cx, cy, w] = METRO[k];
      const spread = 0.05 + 0.35 * Math.sqrt(w);
      lng = cx + gauss(rnd) * spread;
      lat = cy + gauss(rnd) * spread * 0.8;
    } else {                                   // rural / highway tail
      lng = -73 + rnd() * 39;
      lat = -33 + rnd() * 29;
    }
    pts[i * 2] = Math.max(-179.9, Math.min(179.9, lng));
    pts[i * 2 + 1] = Math.max(-84, Math.min(84, lat));
  }
  return pts;
}

/** Per-device heading/speed state for a road-like random walk. */
export function makeMotion(n, seed = 2, metersPerTick = 12) {
  const rnd = rng(seed);
  const head = new Float64Array(n);
  const speed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    head[i] = rnd() * 2 * Math.PI;
    speed[i] = metersPerTick * (0.3 + 1.4 * rnd());
  }
  return { head, speed, rnd };
}

const M_PER_DEG = 111320;

/** Advance device `i` one tick, writing into pts. @returns [lng, lat] */
export function step(pts, mo, i) {
  const { head, speed, rnd } = mo;
  const r = rnd();
  if (r < 0.0002) {                               // GPS jump / re-spawn nearby
    pts[i * 2] += (rnd() - 0.5) * 0.4;
    pts[i * 2 + 1] += (rnd() - 0.5) * 0.4;
  } else {
    head[i] += (rnd() - 0.5) * 0.6;               // gentle turn
    if (r < 0.01) head[i] = rnd() * 2 * Math.PI;  // turn a corner
    const lat = pts[i * 2 + 1];
    const cos = Math.max(0.15, Math.cos(lat * Math.PI / 180));
    pts[i * 2] += Math.cos(head[i]) * speed[i] / (M_PER_DEG * cos);
    pts[i * 2 + 1] += Math.sin(head[i]) * speed[i] / M_PER_DEG;
  }
  if (pts[i * 2] < -179.9 || pts[i * 2] > 179.9) { pts[i * 2] = Math.max(-179.9, Math.min(179.9, pts[i * 2])); head[i] += Math.PI; }
  if (pts[i * 2 + 1] < -84 || pts[i * 2 + 1] > 84) { pts[i * 2 + 1] = Math.max(-84, Math.min(84, pts[i * 2 + 1])); head[i] += Math.PI; }
  return [pts[i * 2], pts[i * 2 + 1]];
}

export function geojson(pts) {
  const n = pts.length / 2;
  const f = new Array(n);
  for (let i = 0; i < n; i++) {
    f[i] = { type: 'Feature', properties: { id: i },
             geometry: { type: 'Point', coordinates: [pts[i * 2], pts[i * 2 + 1]] } };
  }
  return f;
}

export const fmt = (x, d = 1) => x.toLocaleString('en-US', { maximumFractionDigits: d });
export function table(rows) {
  const cols = Object.keys(rows[0]);
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c]).length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c).padStart(w[i])).join('  ');
  console.log(line(cols));
  console.log('  ' + w.map(x => '-'.repeat(x)).join('  '));
  for (const r of rows) console.log(line(cols.map(c => r[c])));
}
