// Run the published demo's real code against a minimal DOM shim, so a typo or a
// bad code path in the embedded demo fails here instead of in the artifact.
import { readFileSync } from 'fs';

const calls = { fillRect: 0, arc: 0, fillText: 0, stroke: 0 };
const ctxStub = new Proxy({
  setTransform() {}, fillRect() { calls.fillRect++; }, beginPath() {}, moveTo() {}, lineTo() {},
  stroke() { calls.stroke++; }, arc() { calls.arc++; }, fill() {}, fillText() { calls.fillText++; },
}, { get: (t, k) => (k in t ? t[k] : undefined), set: () => true });

const values = { 'nc-zoom': '11', 'nc-count': '20000', 'nc-rate': '4000', 'nc-mode': 'net' };
const handlers = new Map();
const mk = (id) => ({
  id, textContent: '', style: {},
  get value() { return values[id]; }, set value(v) { values[id] = String(v); },
  getContext: () => ctxStub, clientWidth: 900, clientHeight: 460, width: 0, height: 0,
  addEventListener(ev, fn) { handlers.set(id + ':' + ev, fn); },
  setPointerCapture() {}, setAttribute() {},
});
const nodes = new Map();
globalThis.document = {
  documentElement: {},
  getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, mk(id)); return nodes.get(id); },
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#888888' });
globalThis.window = { devicePixelRatio: 2, matchMedia: () => ({ matches: false }), addEventListener() {} };
let clock = 0;
globalThis.performance = { now: () => Date.now() + clock };
let frames = 0, pending = null;
globalThis.requestAnimationFrame = (fn) => { pending = fn; };

const lib = readFileSync('demo/netcluster.bundle.js', 'utf8');
const demo = readFileSync('demo/demo.js', 'utf8');
new Function(lib + '\n' + demo)();

function runFrames(n, label) {
  for (let i = 0; i < n; i++) {
    if (!pending) throw new Error('demo stopped scheduling frames at ' + label);
    const fn = pending; pending = null; fn(); frames++; clock += 20;   // advance so the 400 ms readout branch fires
  }
  const drawn = nodes.get('nc-drawn').textContent;
  const markers = nodes.get('nc-markers').textContent;
  if (!drawn || drawn === '0') throw new Error(`no clusters produced (${label})`);
  console.log(`  ${label}: ${drawn} itens / ${markers} marcadores no viewport`);
}
runFrames(20, 'z11 netcluster');
values['nc-zoom'] = '15'; handlers.get('nc-zoom:input')({ target: { value: '15' } });
runFrames(10, 'z15 netcluster');
values['nc-mode'] = 'grid';
runFrames(5, 'z15 grade fixa');
values['nc-mode'] = 'net';
handlers.get('nc-play:click')({ target: mk('nc-play') });      // pause
runFrames(3, 'pausado');
handlers.get('nc-play:click')({ target: mk('nc-play') });      // resume
values['nc-count'] = '5000'; handlers.get('nc-count:change')({ target: { value: '5000' } });
runFrames(10, 'apos trocar contagem');
handlers.get('nc-canvas:pointerdown')({ clientX: 100, clientY: 100, pointerId: 1 });
handlers.get('nc-canvas:pointermove')({ clientX: 260, clientY: 180 });
handlers.get('nc-canvas:pointerup')({ pointerId: 1 });
runFrames(5, 'apos arrastar');
handlers.get('nc-canvas:wheel')({ deltaY: -1, preventDefault() {} });
runFrames(5, 'apos roda do mouse');
const g = (id) => document.getElementById(id).textContent;
for (const id of ['nc-moves', 'nc-us', 'nc-query', 'nc-frame', 'nc-build', 'nc-zoomv']) {
  if (!g(id) || g(id) === '\u2014') throw new Error('readout never populated: ' + id);
}
console.log(`  readouts: ${g('nc-moves')} mov/s, ${g('nc-us')} us/mov, ${g('nc-query')} ms/consulta, ` +
            `${g('nc-frame')} ms/quadro, build ${g('nc-build')}, ${g('nc-zoomv')}`);
console.log(`  drew ${calls.arc} circles, ${calls.fillText} labels over ${frames} frames`);
console.log('DEMO HEADLESS TEST PASSED');
