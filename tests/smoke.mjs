// Дымовая проверка собранной PWA и живого API на loopback. Нужен PostgreSQL
// для полноценного каталога; без него проверяются живость, готовность и статика.
import assert from 'node:assert/strict';
import { preview } from 'vite';
import { createPool } from '../api/db.mjs';
import { makeServer } from '../api/server.mjs';

const pool = createPool({ max: 2, connectionTimeoutMillis: 2000 });
const api = makeServer({ pool });
let site;
try {
  await api.listen({ host: '127.0.0.1', port: 3100 });
  site = await preview({ preview: { host: '127.0.0.1', port: 4173, strictPort: true } });

  const checks = [
    ['/', 200, '<!doctype html>'],
    ['/manifest.webmanifest', 200, 'standalone'],
    ['/sw.js', 200, 'ryadom-'],
    ['/api/health/live', 200, '"ok":true'],
  ];
  for (const [path, status, marker] of checks) {
    const response = await fetch(`http://127.0.0.1:4173${path}`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, status, `${path}: ${response.status}`);
    assert((await response.text()).includes(marker), path);
    console.log(`${path} HTTP ${status}`);
  }

  const ready = await fetch('http://127.0.0.1:4173/api/health/ready', { signal: AbortSignal.timeout(3000) });
  assert.ok([200, 503].includes(ready.status), `readiness: ${ready.status}`);
  console.log(`/api/health/ready HTTP ${ready.status}`);

  const places = await fetch('http://127.0.0.1:4173/api/v1/places', { signal: AbortSignal.timeout(3000) });
  if (ready.status === 200) {
    assert.equal(places.status, 200);
    assert.ok(Array.isArray((await places.json()).items));
  } else {
    assert.ok(places.status >= 500, 'без БД каталог не должен выглядеть рабочим');
  }
  console.log(`/api/v1/places HTTP ${places.status}`);
} finally {
  if (site) await new Promise((resolve, reject) => site.httpServer.close(error => error ? reject(error) : resolve()));
  await api.close();
  await pool.end();
}
