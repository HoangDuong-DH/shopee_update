import { createHash, createDecipheriv } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { safeSystemEnvironment, runProcess, rootIdentity } from './onboarding-core.mjs';

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const identifier = name => {
  if (!/^[a-z][a-z0-9_]*$/.test(name ?? '')) throw Error('TRANSFER_DATABASE_IDENTIFIER_INVALID');
  return `"${name}"`;
};
export function sourceDatabase(connectionString) {
  let url; try { url = new URL(connectionString); } catch { throw Error('TRANSFER_DATABASE_TARGET_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || !url.username || !/^\/[a-z][a-z0-9_]*$/.test(url.pathname) || url.search || url.hash
    || Number(url.port || 5432) < 1024 || Number(url.port || 5432) > 65535) throw Error('TRANSFER_DATABASE_TARGET_INVALID');
  return { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), username: decodeURIComponent(url.username) };
}
export function transferPool(connectionString) {
  sourceDatabase(connectionString);
  const { Pool } = createRequire(resolve(toolRoot, 'package.json'))('pg');
  return new Pool({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 120000,
    idle_in_transaction_session_timeout: 120000, application_name: 'listingstudio-private-transfer' });
}
function decrypt(value, key, scope) {
  try {
    const [version, iv, tag, bytes, ...rest] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !bytes || rest.length) throw Error();
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(scope)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(bytes, 'base64url')), decipher.final()]).toString('utf8'));
  } catch { throw Error('TRANSFER_SOURCE_KEY_MISMATCH'); }
}
export async function inventoryTransferDatabase(client, key) {
  const version = (await client.query("SELECT current_setting('server_version_num')::int AS server_version, current_database() AS database, current_user AS username, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser")).rows[0];
  if (Math.floor(Number(version.server_version) / 10000) !== 17) throw Error('TRANSFER_POSTGRES_17_REQUIRED');
  const names = (await client.query("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename COLLATE \"C\"")).rows.map(row => row.name);
  const tables = [];
  for (const name of names) {
    const rows = (await client.query(`SELECT to_jsonb(t)::text AS row_text FROM public.${identifier(name)} t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows;
    const hash = createHash('sha256'); for (const row of rows) hash.update(`${row.row_text}\n`);
    const table = { name, rowCount: rows.length, sha256: hash.digest('hex') };
    if (name === 'shop_listing_media_blobs') {
      const projected = (await client.query(`SELECT (to_jsonb(t)-'storage_path')::text AS row_text FROM public.${identifier(name)} t ORDER BY (to_jsonb(t)-'storage_path')::text COLLATE "C"`)).rows;
      const unchanged = createHash('sha256'); for (const row of projected) unchanged.update(`${row.row_text}\n`);
      table.withoutStoragePathSha256 = unchanged.digest('hex');
    }
    tables.push(table);
  }
  if (!names.includes('schema_migrations')) throw Error('TRANSFER_MIGRATIONS_REQUIRED');
  const migrations = (await client.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
  const sequenceNames = (await client.query("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' ORDER BY c.relname COLLATE \"C\"")).rows;
  const sequences = [];
  for (const { name } of sequenceNames) {
    const row = (await client.query(`SELECT last_value::text AS value,is_called FROM public.${identifier(name)}`)).rows[0];
    sequences.push({ name, lastValue: row.value, isCalled: row.is_called });
  }
  const storagePaths = names.includes('shop_listing_media_blobs')
    ? (await client.query('SELECT sha256,byte_count::text AS bytes,storage_path AS path FROM shop_listing_media_blobs ORDER BY sha256')).rows.map(row => ({ ...row, bytes: Number(row.bytes) })) : [];
  const connections = names.includes('connections') ? (await client.query('SELECT id,environment,partner_id,shop_id,revision,token_ciphertext,partner_key_ciphertext FROM connections ORDER BY id')).rows : [];
  const connectionKeys = { version: 1, connections: [] }; let checkedCiphertexts = 0;
  for (const row of connections) {
    const scope = `${row.environment}:${row.partner_id}:${row.shop_id}`;
    const entry = { id: row.id, environment: row.environment, partnerId: row.partner_id, shopId: row.shop_id, revision: row.revision, partner: null, token: null };
    for (const [column, field] of [['partner_key_ciphertext', 'partner'], ['token_ciphertext', 'token']]) {
      if (row[column] !== null && row[column] !== undefined) { entry[field] = decrypt(row[column], key, scope); checkedCiphertexts++; }
    }
    connectionKeys.connections.push(entry);
  }
  return { inventory: { version: 1, postgresMajor: 17, migrations, tables, sequences, storagePaths,
    credentials: { checkedCiphertexts, keyMatches: true } }, connectionKeys, databaseIdentity: version };
}
async function binaryTool(command, args, { file, operation = 'dump', env, cwd = toolRoot, timeoutMs = 120000 }) {
  const handle = await open(file, operation === 'dump' ? 'wx' : 'r');
  try {
    await new Promise((done, fail) => {
      const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false,
        stdio: operation === 'dump' ? ['ignore', handle.fd, 'ignore'] : [handle.fd, 'ignore', 'ignore'] });
      let finished = false;
      const finish = error => { if (finished) return; finished = true; clearTimeout(timer); error ? fail(error) : done(); };
      const timer = setTimeout(() => { child.kill(); finish(Error('TRANSFER_DATABASE_TOOL_TIMEOUT')); }, timeoutMs);
      child.once('error', () => finish(Error('TRANSFER_DATABASE_TOOL_UNAVAILABLE')));
      child.once('exit', code => finish(code === 0 ? null : Error('TRANSFER_DATABASE_TOOL_FAILED')));
    });
  } finally { await handle.close(); }
}
export async function inspectTransferContainer({ container, database, projectRoot, expectedProject, run = runProcess, target = false }) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(container ?? '')) throw Error('TRANSFER_CONTAINER_REQUIRED');
  const result = await run({ command: 'docker', args: ['inspect', container, '--format', '{"image":{{json .Config.Image}},"labels":{{json .Config.Labels}},"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}},"state":{{json .State}}}'],
    cwd: projectRoot, env: safeSystemEnvironment(), timeoutMs: 15000 });
  let value; try { value = JSON.parse(result.stdout); } catch { throw Error('TRANSFER_CONTAINER_IDENTITY_UNVERIFIED'); }
  const root = await rootIdentity(projectRoot);
  const projects = expectedProject ? [expectedProject] : ['shopee-product-uploader-dev', root.composeProject];
  const project = value.labels?.['com.docker.compose.project'];
  if (result.exitCode !== 0 || !/^postgres:17(?:[.-]|$)/.test(value.image ?? '') || !projects.includes(project)
    || value.labels?.['com.docker.compose.service'] !== 'postgres' || value.state?.Running !== true || value.state?.Health?.Status !== 'healthy'
    || !value.ports?.['5432/tcp']?.some(port => ['127.0.0.1', '::1'].includes(port.HostIp) && port.HostPort === String(database.port))
    || value.ports['5432/tcp'].length !== 1 || Object.keys(value.ports).length !== 1
    || !value.mounts?.some(mount => mount.Type === 'volume' && mount.Name === `${project}_database` && mount.Destination === '/var/lib/postgresql/data'))
    throw Error('TRANSFER_CONTAINER_IDENTITY_UNVERIFIED');
  return { container, postgresMajor: 17, project };
}
function pgEnvironment(source) {
  const url = new URL(source.connectionString), database = sourceDatabase(source.connectionString);
  return { ...safeSystemEnvironment(), PGHOST: database.host, PGPORT: String(database.port), PGDATABASE: database.database,
    PGUSER: database.username, PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '5', PGSSLMODE: 'disable' };
}
export async function captureTransferDatabase({ source, dumpFile, dump, client: providedClient, pgDump, sourceContainer, run = runProcess }) {
  const identity = sourceDatabase(source.connectionString);
  const pool = providedClient ? null : transferPool(source.connectionString);
  const client = providedClient ?? await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL lock_timeout='5s'"); await client.query("SET LOCAL TIME ZONE 'UTC'");
    const version = (await client.query("SELECT current_setting('server_version_num')::int AS server_version, current_database() AS database, current_user AS username")).rows[0];
    if (Math.floor(Number(version.server_version) / 10000) !== 17 || version.database !== identity.database || version.username !== identity.username)
      throw Error('TRANSFER_SOURCE_DATABASE_UNVERIFIED');
    const tables = (await client.query("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename COLLATE \"C\"")).rows.map(row => row.name);
    if (!tables.length) throw Error('TRANSFER_SOURCE_DATABASE_EMPTY');
    await client.query(`LOCK TABLE ${tables.map(name => `public.${identifier(name)}`).join(', ')} IN SHARE MODE`);
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    if (!/^[a-zA-Z0-9-]+$/.test(snapshot ?? '')) throw Error('TRANSFER_SNAPSHOT_INVALID');
    const result = await inventoryTransferDatabase(client, source.appEncryptionKey);
    const args = ['--format=custom', '--no-owner', '--no-privileges', '--schema=public', `--snapshot=${snapshot}`];
    if (dump) await dump(dumpFile, { source, snapshot, args });
    else if (sourceContainer) {
      await inspectTransferContainer({ container: sourceContainer, database: identity, projectRoot: source.projectRoot, run });
      await binaryTool('docker', ['exec', '-e', 'PGPASSWORD', sourceContainer, 'pg_dump', '--username', identity.username,
        '--dbname', identity.database, ...args],
        { file: dumpFile, env: pgEnvironment(source), cwd: source.projectRoot });
    } else {
      const tool = pgDump ?? 'pg_dump';
      const versionResult = await run({ command: tool, args: ['--version'], cwd: source.projectRoot, env: safeSystemEnvironment() });
      if (versionResult.exitCode !== 0 || !/\b17\.\d+/.test(versionResult.stdout ?? '')) throw Error('TRANSFER_PG_DUMP_17_REQUIRED');
      await binaryTool(tool, args, { file: dumpFile, env: pgEnvironment(source) });
    }
    await client.query('COMMIT');
    return { inventory: result.inventory, connectionKeys: result.connectionKeys, consistency: 'repeatable-read-exported-snapshot-share-locks' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw Error(/^[A-Z_]+$/.test(error.message ?? '') ? error.message : 'TRANSFER_SOURCE_SNAPSHOT_FAILED');
  } finally { if (!providedClient) { client.release(); await pool.end(); } }
}
