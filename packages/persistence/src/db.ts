import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
export { Pool };
let manifest: Promise<{ name: string; sql: string; checksum: string }[]> | undefined;
function migrationFiles() {
  return (manifest ??= (async () => {
    const dir = new URL('../migrations/', import.meta.url);
    return Promise.all(
      (await readdir(dir))
        .filter((n) => n.endsWith('.sql'))
        .sort()
        .map(async (name) => {
          const sql = await readFile(new URL(name, dir), 'utf8');
          return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
        }),
    );
  })());
}
export async function probeMigrations(pool: Pool): Promise<void> {
  const expected = await migrationFiles();
  const applied = new Map(
    (await pool.query('SELECT name,checksum FROM schema_migrations')).rows.map((r) => [
      r.name,
      r.checksum,
    ]),
  );
  if (expected.some((m) => applied.get(m.name) !== m.checksum))
    throw new Error('MIGRATIONS_NOT_READY');
}
export async function transaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function migrate(pool: Pool): Promise<void> {
  const migrations = await migrationFiles();
  await transaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(24091001)');
    await c.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const { name, sql, checksum } of migrations) {
      const applied = await c.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (applied.rowCount) {
        if (applied.rows[0].checksum !== checksum) throw new Error('MIGRATION_CHECKSUM_CHANGED');
        continue;
      }
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
    }
  });
}
