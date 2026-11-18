// Применение миграций по порядку с блокировкой от параллельного запуска.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { createPool } from '../api/db.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(pool, { log = () => {} } = {}) {
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(732911)');
    await client.query(`create table if not exists schema_migrations (
      version text primary key,
      checksum text not null,
      applied_at timestamptz not null default now())`);

    const files = (await readdir(join(here, 'migrations'))).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      const { rows } = await client.query('select checksum from schema_migrations where version = $1', [file]);
      const sql = await readFile(join(here, 'migrations', file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (rows[0]) {
        if (rows[0].checksum !== checksum) throw new Error(`миграция ${file} изменена после применения`);
        continue;
      }
      await client.query(sql);
      await client.query('insert into schema_migrations (version, checksum) values ($1, $2)', [file, checksum]);
      applied.push(file);
      log(`применена ${file}`);
    }
    await client.query('commit');
    return { applied };
  } catch (error) {
    try { await client.query('rollback'); } catch { /* соединение уже мертво */ }
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool();
  try {
    const result = await migrate(pool, { log: console.log });
    console.log(result.applied.length ? `применено: ${result.applied.join(', ')}` : 'схема актуальна');
  } catch (error) {
    console.error('миграции не применены:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
