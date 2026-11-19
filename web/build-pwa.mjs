import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const base = (process.env.VITE_BASE || '/').replace(/\/?$/, '/');
const out = process.env.VITE_OUT || '../dist';
const root = new URL('../', import.meta.url);
const dist = new URL(`${out.replace(/^\.\.\//, '')}/`, root);
const files = ['index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable.png',
  ...readdirSync(new URL('assets/', dist)).sort().map(file => `assets/${file}`)].map(file => `${base}${file}`);
const worker = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const hash = createHash('sha256').update(worker);
for (const file of files) hash.update(file).update(readFileSync(new URL(file.slice(base.length), dist)));
writeFileSync(new URL('sw.js', dist), `const CACHE = ${JSON.stringify(`ryadom-${hash.digest('hex').slice(0, 20)}`)};\n` +
  `const BASE = ${JSON.stringify(base)};\n` +
  `const FILES = ${JSON.stringify(files)};\n${worker}`);
