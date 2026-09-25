// Inline the ES modules the index is built from into one classic <script> body
// (no imports), so the demo page stays self-contained under a strict CSP.
//
// The module list is walked from the imports rather than written down here. It
// used to be "cellhash plus netcluster", and when the filtering work moved
// Schema into dimensions.js the bundle went on building at the same size while
// the demo died on `Schema is not defined` -- a broken artifact that only a
// human opening the page would notice.
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join, normalize } from 'path';

const strip = (src) => src
  .replace(/^import .*?;$/gm, '')
  .replace(/^export (class|function|const|let)/gm, '$1')
  .replace(/^export \{[^}]*\};?$/gm, '');

// Depth-first over the import graph, so every module is emitted before the ones
// that use it. Relative specifiers only: anything else would not be inlinable.
const seen = new Set();
const order = [];
const walk = (file) => {
  if (seen.has(file)) return;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/^import .*?from\s*'(\.[^']*)';$/gm)) {
    walk(normalize(join(dirname(file), m[1])));
  }
  order.push(src);
};
walk('src/netcluster.js');

const bundle = order.map(strip).join('\n');
if (/^\s*import\s/m.test(bundle)) throw new Error('bundle still contains an import');
writeFileSync('demo/netcluster.bundle.js', bundle);
console.log(`bundled ${order.length} modules, ${bundle.length} bytes`);
