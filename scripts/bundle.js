// Inline the two ES modules into one classic <script> body (no imports), so the
// demo page stays self-contained under a strict CSP.
import { readFileSync, writeFileSync } from 'fs';
const strip = (f) => readFileSync(f, 'utf8')
  .replace(/^import .*?;$/gm, '')
  .replace(/^export (class|function|const|let)/gm, '$1')
  .replace(/^export \{[^}]*\};?$/gm, '');
const bundle = strip('src/cellhash.js') + '\n' + strip('src/netcluster.js');
writeFileSync('demo/netcluster.bundle.js', bundle);
console.log('bundled', bundle.length, 'bytes');
