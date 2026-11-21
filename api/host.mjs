// Единый HTTPS-вход: статическая PWA из dist/ и API на том же origin.
// Нужен, когда IIS без ARR/URL Rewrite не может проксировать /api/*.
// TLS завершается здесь; API-порт наружу не публикуется.
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPool } from './db.mjs';
import { makeServer } from './server.mjs';
import { startPushLoop } from './pushJobs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(here, '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const cacheFor = (relative) => {
  if (relative === 'sw.js' || relative === 'index.html') return 'no-cache';
  if (relative.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  if (relative.startsWith('icon-')) return 'public, max-age=86400';
  return 'no-cache';
};

function insideDist(relative) {
  if (!relative || relative.includes('\0')) return null;
  let decoded;
  try { decoded = decodeURIComponent(relative); } catch { return null; }
  const target = resolve(DIST, decoded.replace(/^\/+/, ''));
  return target === DIST || target.startsWith(DIST + sep) ? target : null;
}

async function statFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

function sendFile(reply, path, relative, info) {
  return reply
    .code(200)
    .type(MIME[extname(path).toLowerCase()] || 'application/octet-stream')
    .header('Cache-Control', cacheFor(relative))
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Length', info.size)
    .send(createReadStream(path));
}

export function attachStatic(app) {
  app.setNotFoundHandler(async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(405).send({ error: 'method_not_allowed' });
    }
    if (request.url.startsWith('/api/') || request.url === '/api') {
      return reply.code(404).send({ error: 'not_found' });
    }
    const pathname = request.url.split('?')[0];
    const isRoot = pathname === '/';
    const target = insideDist(pathname);
    if (target && !isRoot) {
      const info = await statFile(target);
      if (info) return sendFile(reply, target, pathname.replace(/^\/+/, ''), info);
    }
    // SPA fallback только для навигации на страницы, не для файлов и не для /api.
    const acceptsHtml = String(request.headers.accept || '').includes('text/html');
    const looksLikeFile = extname(pathname) !== '';
    if (!isRoot && (!acceptsHtml || looksLikeFile)) return reply.code(404).send({ error: 'not_found' });
    const index = resolve(DIST, 'index.html');
    const info = await statFile(index);
    if (!info) return reply.code(404).send({ error: 'not_found' });
    return sendFile(reply, index, 'index.html', info);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production' && process.env.DEMO_LOGIN !== '1') {
    console.error('SESSION_SECRET не задан: запуск в production без секрета запрещён');
    process.exit(1);
  }
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 443);
  const pool = createPool();
  const tls = process.env.TLS_PFX
    ? { pfx: await readFile(process.env.TLS_PFX), passphrase: process.env.TLS_PFX_PASSPHRASE }
    : null;
  const app = makeServer({ pool, logger: true, ...(tls ? { https: tls } : {}) });
  attachStatic(app);
  try {
    if (!tls) console.warn('[host] TLS_PFX не задан: запуск по HTTP (только для локальной проверки)');
    await app.listen({ host, port });
    console.log(`[host] слушает ${tls ? 'https' : 'http'}://${host}:${port}`);
    const stopPush = startPushLoop(pool, { logger: app.log });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, async () => { stopPush(); await app.close(); await pool.end(); });
    }
  } catch (error) {
    console.error('[host] не удалось запуститься:', error.message);
    await pool.end();
    process.exitCode = 1;
  }
}


export { DIST };
