// The brief asks for the update cost as a function of local density D.
// The "dirty region" approach (rbush + greedy re-cluster of the neighbourhood)
// costs O(D log N): a denser neighbourhood means more points to re-examine.
// A net has no such term -- separation caps how many CENTERS can sit in any
// ball, no matter how many points are piled there. This measures that claim by
// holding N fixed and squeezing the same fleet into ever smaller areas.
import { NetCluster } from '../src/netcluster.js';
import { rng, table, fmt } from './common.js';

const N = 200_000;
const CENTER = [-46.633, -23.550];
const rows = [];

for (const span of [8, 2, 0.5, 0.125, 0.03, 0.008]) {
  const rnd = rng(42);
  const lng = new Float64Array(N), lat = new Float64Array(N), head = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    lng[i] = CENTER[0] + (rnd() - 0.5) * span;
    lat[i] = CENTER[1] + (rnd() - 0.5) * span;
    head[i] = rnd() * 6.283;
  }
  const nc = new NetCluster({ radius: 40, maxZoom: 16 });
  for (let i = 0; i < N; i++) nc.insert(i, lng[i], lat[i]);

  // local density D: points within one r_maxZoom ball (~48 m at the equator)
  const areaKm2 = (span * 111.32) * (span * 111.32 * Math.cos(CENTER[1] * Math.PI / 180));
  const ballKm2 = Math.PI * 0.0478 * 0.0478;
  const D = N / areaKm2 * ballKm2;

  const stepDeg = 12 / 111320;
  const move = (i) => {
    head[i] += (rnd() - 0.5) * 0.5;
    lng[i] += Math.cos(head[i]) * stepDeg; lat[i] += Math.sin(head[i]) * stepDeg;
    nc.moveTo(i, lng[i], lat[i]);
  };
  for (let i = 0; i < N; i++) move(i);                     // warm
  const before = { ...nc.stats };
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) move(i);
  const us = Number(process.hrtime.bigint() - t0) / 1000 / N;

  const leaves = [...nc.ids.values()].filter(s => nc.tz[s] > nc.maxZoom).length;
  rows.push({
    'lado da área': span >= 1 ? fmt(span * 111, 0) + ' km' : fmt(span * 111320, 0) + ' m',
    'D (pts / bola de 48 m)': fmt(D, D < 10 ? 2 : 0),
    'pontos agrupados no zoom máx': fmt(100 * leaves / N, 1) + '%',
    'mover 1 ponto': fmt(us, 2) + ' us',
    'sondagens/mov': fmt((nc.stats.probes - before.probes) / N, 1),
    'caminho rápido': fmt(100 * (nc.stats.movesFast - before.movesFast) / (nc.stats.moves - before.moves), 1) + '%',
  });
}
console.log('\n=== CUSTO DE UPDATE vs DENSIDADE LOCAL (N = ' + fmt(N, 0) + ' fixo) ===\n');
table(rows);
console.log('\n  D varia ' + fmt(1e6, 0) + 'x entre a primeira e a ultima linha.');
