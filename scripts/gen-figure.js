// Emit the net-hierarchy figure straight from the running index, so the picture
// is actual output rather than an illustration.
import { NetCluster, project, PREC } from '../src/index.js';
import { writeFileSync } from 'fs';

const SEED = 20260820;
let s = SEED >>> 0;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());

// a small town: four loose knots of devices inside a ~3 km box
const CX = -46.65, CY = -23.55, SPAN = 0.030;
const knots = [[-0.008, -0.006], [0.009, -0.008], [0.006, 0.008], [-0.009, 0.007], [0.0, 0.0]];
const pts = [];
for (let i = 0; i < 56; i++) {
  const k = knots[i % knots.length];
  pts.push([CX + k[0] + gauss() * 0.0035, CY + k[1] + gauss() * 0.0030]);
}

const idx = new NetCluster({ radius: 40, maxZoom: 18, extent: 512 });
pts.forEach((p, i) => idx.insert(i, p[0], p[1]));

const LEVELS = [12, 13, 14];
const PANEL = 176, GAP = 30, TOP = 34, LEFT = 8;
const W = LEFT * 2 + PANEL * 3 + GAP * 2, H = TOP + PANEL + 40;

const [x0, y0] = project(CX - SPAN / 2, CY + SPAN / 2);
const [x1, y1] = project(CX + SPAN / 2, CY - SPAN / 2);
const scale = PANEL / (x1 - x0);
const px = (q, p) => LEFT + p * (PANEL + GAP) + (q - x0) * scale;
const py = (q) => TOP + (q - y0) * scale;
const f = (v) => Math.round(v * 10) / 10;

let svg = '';
LEVELS.forEach((z, p) => {
  const rPix = idx.r[z] * scale;
  const px0 = LEFT + p * (PANEL + GAP);
  svg += `\n  <g>`;
  svg += `\n    <rect class="fg-panel" x="${px0}" y="${TOP}" width="${PANEL}" height="${PANEL}" rx="3"/>`;
  // exclusion discs of the centers of C_z
  const centers = new Set();
  for (let i = 0; i < pts.length; i++) centers.add(idx.representative(i, z));
  for (const c of centers) {
    svg += `\n    <circle class="fg-ring" cx="${f(px(idx.qx[c], p))}" cy="${f(py(idx.qy[c]))}" r="${f(rPix)}"/>`;
  }
  // membership links
  for (let i = 0; i < pts.length; i++) {
    const c = idx.representative(i, z);
    if (c === idx.ids.get(i)) continue;
    const me = idx.ids.get(i);
    svg += `\n    <line class="fg-link" x1="${f(px(idx.qx[me], p))}" y1="${f(py(idx.qy[me]))}" x2="${f(px(idx.qx[c], p))}" y2="${f(py(idx.qy[c]))}"/>`;
  }
  for (let i = 0; i < pts.length; i++) {
    const me = idx.ids.get(i);
    const isC = centers.has(me);
    svg += `\n    <circle class="${isC ? 'fg-ctr' : 'fg-pt'}" cx="${f(px(idx.qx[me], p))}" cy="${f(py(idx.qy[me]))}" r="${isC ? 3.1 : 1.7}"/>`;
  }
  const meters = Math.round(idx.r[z] / PREC * 40075016 * Math.cos(CY * Math.PI / 180));
  svg += `\n    <text class="fg-h" x="${px0}" y="20">z = ${z}</text>`;
  svg += `\n    <text class="fg-s" x="${px0 + PANEL}" y="20" text-anchor="end">r = ${meters} m &#183; ${centers.size} clusters</text>`;
  // scale bar = r_z
  svg += `\n    <line class="fg-bar" x1="${px0 + 10}" y1="${TOP + PANEL + 14}" x2="${f(px0 + 10 + rPix)}" y2="${TOP + PANEL + 14}"/>`;
  svg += `\n    <text class="fg-s" x="${f(px0 + 14 + rPix)}" y="${TOP + PANEL + 18}">r</text>`;
  svg += `\n  </g>`;
});

const out = `<svg viewBox="0 0 ${W} ${H}" role="img" class="fig" aria-label="The same 56 devices indexed at zoom 12, 13 and 14. At each level the centers are separated by at least the level radius r and every device is linked to the center that represents it; the center set grows as the radius halves.">${svg}\n</svg>\n`;
writeFileSync('docs/fig-nets.svg', out);
console.log('wrote docs/fig-nets.svg', out.length, 'bytes');
for (const z of LEVELS) {
  const c = new Set(); for (let i = 0; i < pts.length; i++) c.add(idx.representative(i, z));
  console.log(`  z=${z}: ${c.size} clusters, r=${Math.round(idx.r[z] / PREC * 40075016 * Math.cos(CY * Math.PI / 180))} m`);
}
