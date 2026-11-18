import Fastify from 'fastify';
import { pathToFileURL } from 'node:url';
import { createPool } from './db.mjs';
import { routes } from './routes.mjs';

export function makeServer({ pool, demoLogin = process.env.DEMO_LOGIN === '1', logger = false, ...options } = {}) {
  if (!pool) throw new Error('makeServer требует pool PostgreSQL');
  const app = Fastify({ logger, trustProxy: true, ...options });
  routes(app, { pool, demoLogin });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production' && process.env.DEMO_LOGIN !== '1') {
    console.error('SESSION_SECRET не задан: запуск в production без секрета запрещён');
    process.exit(1);
  }
  const pool = createPool();
  const app = makeServer({ pool, logger: true });
  const shutdown = async (signal) => {
    app.log.info({ signal }, 'остановка');
    await app.close();
    await pool.end();
  };
  try {
    await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 3100) });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void shutdown(signal));
  } catch (error) {
    app.log.error(error);
    await pool.end();
    process.exitCode = 1;
  }
}
