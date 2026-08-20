import { readFileSync, writeFileSync } from 'fs';
let html = readFileSync('docs/report.src.html', 'utf8');
html = html.replace('<!--FIGNETS-->', readFileSync('docs/fig-nets.svg', 'utf8').trim());
html = html.replace('/*LIB*/', '\n' + readFileSync('demo/netcluster.bundle.js', 'utf8') + '\n');
html = html.replace('/*DEMO*/', '\n' + readFileSync('demo/demo.js', 'utf8') + '\n');
writeFileSync('docs/report.html', html);
console.log('docs/report.html', (html.length / 1024).toFixed(0) + ' KB');
