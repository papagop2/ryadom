// Подключение к PostgreSQL. Параметры берутся только из окружения службы,
// пароли не попадают в файлы репозитория.
import pg from 'pg';

const { Pool } = pg;

export function dbConfig(overrides = {}) {
  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'rjadom',
    user: process.env.PGUSER || 'rjadom_app',
    password: process.env.PGPASSWORD || undefined,
    max: Number(process.env.PGPOOL_MAX || 8),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    application_name: 'rjadom-api',
    ...overrides,
  };
}

export function createPool(overrides) {
  const pool = new Pool(dbConfig(overrides));
  pool.on('error', (error) => console.error('[pg] idle client error:', error.message));
  return pool;
}

export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try { await client.query('rollback'); } catch { /* соединение уже мертво */ }
    throw error;
  } finally {
    client.release();
  }
}

export const isUniqueViolation = (error) => error?.code === '23505';
export const isCheckViolation = (error) => error?.code === '23514';
