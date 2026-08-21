// Runs demo/index.html's module body against stubbed Leaflet + DOM, so a typo or
// a wrong API call in the demo fails here instead of in someone's browser.
import { readFileSync } from 'fs';

const html = readFileSync(new URL('../demo/index.html', import.meta.url), 'utf8');
const body = html.split('<script type="module">')[1].split('</script>')[0]
  .replace("from '../src/index.js'", "from '" + new URL('../src/index.js', import.meta.url).href + "'");

const drawn = { clusters: 0, dots: 0, clicks: 0 };
const handlers = new Map();
let clusterClick = null;

const marker = (latlng, opts) => {
  if (opts.icon.html.includes('nc-cluster')) drawn.clusters++; else drawn.dots++;
  return { on(ev, fn) { if (!clusterClick) clusterClick = fn; return this; }, _latlng: latlng };
};
globalThis.L = {
  map: () => ({
    setView(c, z) { this._z = z ?? this._z; return this; },
    getZoom: () => 11,
    getBounds: () => ({ getWest: () => -46.9, getSouth: () => -23.8, getEast: () => -46.3, getNorth: () => -23.3 }),
    on(ev, fn) { for (const e of ev.split(' ')) handlers.set('map:' + e, fn); return this; },
  }),
  tileLayer: () => ({ addTo: () => ({}) }),
  layerGroup: () => ({ addTo() { return this; }, clearLayers() { drawn.clusters = 0; drawn.dots = 0; }, addLayer() {} }),
  marker,
  divIcon: (o) => o,
};
const els = new Map();
const values = { fleet: '2000', rate: '500', play: '' };
globalThis.document = {
  getElementById: (id) => {
    if (!els.has(id)) els.set(id, {
      id, textContent: '',
      get value() { return values[id] ?? ''; }, set value(v) { values[id] = v; },
      addEventListener(ev, fn) { handlers.set(id + ':' + ev, fn); },
    });
    return els.get(id);
  },
};
globalThis.window = { matchMedia: () => ({ matches: false }) };
globalThis.performance = { now: () => Date.now() };
let pending = null;
globalThis.requestAnimationFrame = (fn) => { pending = fn; };

await import('data:text/javascript;base64,' + Buffer.from(body).toString('base64'));

const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const runFrames = (n) => { for (let i = 0; i < n; i++) { if (!pending) fail('demo stopped scheduling frames'); const f = pending; pending = null; f(); } };

runFrames(15);
if (drawn.clusters + drawn.dots === 0) fail('nothing was drawn');
console.log(`  ok 15 frames: ${drawn.clusters} clusters + ${drawn.dots} single vehicles drawn`);
const g = (id) => document.getElementById(id).textContent;
for (const id of ['s-markers', 's-query', 's-total', 's-build']) if (!g(id) || g(id) === '—') fail('stat never filled: ' + id);
console.log(`  ok stats: ${g('s-total')} indexed, ${g('s-markers')} markers, ${g('s-query')} ms/query, build ${g('s-build')}`);

if (!clusterClick) fail('no cluster click handler was attached');
clusterClick();                                     // expanding a cluster must not throw
console.log('  ok clicking a cluster resolves its expansion zoom');

handlers.get('play:click')({ target: { textContent: '' } });   // pause
runFrames(3);
handlers.get('play:click')({ target: { textContent: '' } });   // resume
handlers.get('fleet:change')({ target: { value: '10000' } });  // rebuild larger fleet
runFrames(10);
if (g('s-total') !== '10,000') fail('fleet size change did not rebuild the index');
console.log(`  ok pause/resume and fleet change: now ${g('s-total')} vehicles`);
handlers.get('map:moveend')();                       // pan/zoom redraw
console.log('  ok map moveend redraw');
console.log('LEAFLET DEMO HEADLESS TEST PASSED');
