import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const dist = new URL('../dist/', import.meta.url);
const files = ['index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable.png',
  ...readdirSync(new URL('assets/', dist)).sort().map(file => `assets/${file}`)];
const worker = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const hash = createHash('sha256').update(worker);
for (const file of files) hash.update(file).update(readFileSync(new URL(file, dist)));
writeFileSync(new URL('sw.js', dist), `const CACHE = ${JSON.stringify(`ryadom-${hash.digest('hex').slice(0, 20)}`)};\n` +
  `const FILES = ${JSON.stringify(files.map(file => `/${file}`))};\n${worker}`);
