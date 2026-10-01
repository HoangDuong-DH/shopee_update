import { mkdir, readFile, writeFile, readdir, lstat, copyFile, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { contained, readIsolated } from './internal-environment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function databaseIdentity(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1))
    throw Error('BACKUP_DATABASE_INVALID');
  return { host: url.hostname, port: Number(url.port || 5432), database: decodeURIComponent(url.pathname.slice(1)) };
}
export function validateRestoreTarget(value, original) {
  const target = databaseIdentity(value);
  if (target.host !== '127.0.0.1' || target.port !== 5443 || !['shopee_internal_test', 'shopee_internal_restore'].includes(target.database))
    throw Error('RESTORE_REQUIRES_ISOLATED_TARGET');
  if (original && ['127.0.0.1', 'localhost', '[::1]'].includes(original.host)
    && target.port === original.port && target.database === original.database) throw Error('RESTORE_SOURCE_EQUALS_TARGET');
  return target;
}
function pgEnvironment(connectionString) {
  const url = new URL(connectionString); databaseIdentity(connectionString);
  // Credentials are passed through the child environment, never command arguments/logs.
  const env = {};
  for (const [key, value] of Object.entries(process.env))
    if (/^(path|systemroot|windir|temp|tmp|home|userprofile|appdata)$/i.test(key)) env[key] = value;
  return { ...env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '10',
    PGSSLMODE: url.searchParams.get('sslmode') || 'prefer' };
}
async function pgTool(tool, args, env) {
  await new Promise((ok, fail) => {
    const child = spawn(tool, args, { env, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); fail(Error('BACKUP_TOOL_TIMEOUT')); }, 30 * 60 * 1000);
    child.once('error', () => { clearTimeout(timer); fail(Error('BACKUP_TOOL_UNAVAILABLE')); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? ok() : fail(Error('BACKUP_TOOL_FAILED')); });
  });
}
/** Docker fallback is restricted to this project's fixed rehearsal container.
 * It is intentionally unavailable for backups of the operating database. */
async function isolatedDockerPg(docker, operation, connectionString, file) {
  const identity = databaseIdentity(connectionString);
  if (identity.host !== '127.0.0.1' || identity.port !== 5443
    || !['shopee_internal_test', 'shopee_internal_restore'].includes(identity.database))
    throw Error('BACKUP_DOCKER_REQUIRES_ISOLATED_DATABASE');
  const handle = await open(file, operation === 'dump' ? 'wx' : 'r');
  try {
    const command = operation === 'dump'
      ? ['pg_dump', '--username', 'shopee_internal', '--dbname', identity.database, '--format=custom', '--no-owner', '--no-privileges']
      : ['pg_restore', '--username', 'shopee_internal', '--dbname', identity.database, '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges'];
    await new Promise((ok, fail) => {
      const child = spawn(docker, ['exec', '-i', 'shopee-internal-rehearsal-postgres-1', ...command], {
        windowsHide: true, stdio: operation === 'dump' ? ['ignore', handle.fd, 'ignore'] : [handle.fd, 'ignore', 'ignore'] });
      const timer = setTimeout(() => { child.kill(); fail(Error('BACKUP_TOOL_TIMEOUT')); }, 30 * 60 * 1000);
      child.once('error', () => { clearTimeout(timer); fail(Error('BACKUP_TOOL_UNAVAILABLE')); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? ok() : fail(Error('BACKUP_TOOL_FAILED')); });
    });
  } finally { await handle.close(); }
}
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function noLinks(path) {
  let at = resolve(path);
  while (true) {
    const stat = await lstat(at).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (stat?.isSymbolicLink()) throw Error('BACKUP_SYMLINK_FORBIDDEN');
    const up = dirname(at); if (up === at) return; at = up;
  }
}
async function files(directory) {
  await noLinks(directory);
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error('BACKUP_SYMLINK_FORBIDDEN');
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
    else throw Error('BACKUP_UNSUPPORTED_FILE');
  }
  return result.sort();
}

/** Caller must quiesce all writers first. Failed/incomplete backups never get manifest.json. */
export async function createSnapshot({ output, database, sources, dump, quiesced }) {
  if (quiesced !== true) throw Error('BACKUP_REQUIRES_QUIESCED_WRITERS');
  output = resolve(output); await noLinks(output);
  if (!sources.length || sources[0].label !== 'data') throw Error('BACKUP_DATA_REQUIRED');
  const labels = new Set();
  for (const source of sources) {
    if (!/^[a-z0-9_-]+$/.test(source.label) || labels.has(source.label)) throw Error('BACKUP_LABEL_INVALID');
    labels.add(source.label);
    source.path = resolve(source.path); await noLinks(source.path);
    if (output === source.path || contained(source.path, output) || contained(output, source.path))
      throw Error('BACKUP_OUTPUT_OVERLAPS_SOURCE');
  }
  // Inventory before output creation also catches unreadable/missing roots early.
  const inventories = await Promise.all(sources.map(async source => ({ ...source, paths: await files(source.path) })));
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // EEXIST is intentional: never reuse or overwrite a previous backup.
  const manifest = { version: 1, createdAt: new Date().toISOString(), database, quiesced: true,
    completeness: 'selected-roots-only', encryptionKeyIncluded: false,
    roots: sources.map(({ label, path }) => ({ label, originalPath: path })), files: [] };
  const record = async path => {
    const stat = await lstat(path);
    manifest.files.push({ path: relative(output, path).replaceAll('\\', '/'), bytes: stat.size, sha256: await sha256(path) });
  };
  const dumpFile = resolve(output, 'database.dump'); await dump(dumpFile); await record(dumpFile);
  for (const source of inventories) {
    for (const path of source.paths) {
      const before = await lstat(path), beforeHash = await sha256(path);
      const target = resolve(output, source.label, relative(source.path, path));
      await mkdir(dirname(target), { recursive: true }); await copyFile(path, target);
      const after = await lstat(path);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || beforeHash !== await sha256(path)
        || beforeHash !== await sha256(target)) throw Error('BACKUP_SOURCE_CHANGED');
      await record(target);
    }
    const afterPaths = await files(source.path);
    if (JSON.stringify(source.paths) !== JSON.stringify(afterPaths)) throw Error('BACKUP_SOURCE_CHANGED');
  }
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return manifest;
}

export async function verifySnapshot(directory) {
  directory = resolve(directory); await noLinks(directory);
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('BACKUP_MANIFEST_INVALID');
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0)
      throw Error('BACKUP_MANIFEST_INVALID');
    const path = resolve(directory, file.path);
    if (!contained(directory, path) || seen.has(path.toLowerCase())) throw Error('BACKUP_MANIFEST_PATH_INVALID');
    seen.add(path.toLowerCase()); await noLinks(path);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size !== file.bytes || await sha256(path) !== file.sha256) throw Error('BACKUP_CHECKSUM_MISMATCH');
  }
  if (!manifest.files.some(f => f.path === 'database.dump')) throw Error('BACKUP_DUMP_REQUIRED');
  return manifest;
}

function options(args) {
  const values = { receiptRoots: [] };
  const mappings = { '--source-env': 'sourceEnv', '--output': 'output', '--backup': 'backup', '--pg-dump': 'pgDump', '--pg-restore': 'pgRestore',
    '--rehearsal-database': 'rehearsalDatabase', '--isolated-docker': 'isolatedDocker' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--quiesced') values.quiesced = true;
    else if (arg === '--confirm-rehearsal') values.confirm = true;
    else if (arg === '--receipt-root' && args[i + 1]) values.receiptRoots.push(args[++i]);
    else if (mappings[arg] && args[i + 1]) values[mappings[arg]] = args[++i];
    else throw Error('BACKUP_ARGUMENT_INVALID');
  }
  return values;
}

async function cli() {
  const command = process.argv[2], opts = options(process.argv.slice(3));
  if (command === 'verify') {
    if (!opts.backup) throw Error('BACKUP_PATH_REQUIRED');
    const result = await verifySnapshot(opts.backup);
    console.log(JSON.stringify({ verifiedFiles: result.files.length, scope: result.completeness, restoreTested: false })); return;
  }
  if (command === 'restore-rehearsal') {
    if (!opts.backup || !opts.confirm) throw Error('RESTORE_CONFIRMATION_REQUIRED');
    const manifest = await verifySnapshot(opts.backup);
    const { config, env } = await readIsolated(root);
    const targetUrl = new URL(env.DATABASE_URL);
    if (opts.rehearsalDatabase) targetUrl.pathname = '/' + opts.rehearsalDatabase;
    const targetConnection = targetUrl.toString();
    validateRestoreTarget(targetConnection, manifest.database);
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: targetConnection, connectionTimeoutMillis: 5000, query_timeout: 5000 });
    try {
      const count = (await pool.query("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')")).rows[0].count;
      if (Number(count) !== 0) throw Error('RESTORE_TARGET_NOT_EMPTY');
      // No --clean, DROP DATABASE, overwrite or live restart operation exists here.
      if (opts.isolatedDocker) await isolatedDockerPg(opts.isolatedDocker, 'restore', targetConnection, resolve(opts.backup, 'database.dump'));
      else await pgTool(opts.pgRestore || 'pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges',
        '--dbname', databaseIdentity(targetConnection).database, resolve(opts.backup, 'database.dump')], pgEnvironment(targetConnection));
      const tables = (await pool.query("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows[0].count;
      await writeFile(resolve(opts.backup, `rehearsal-${Date.now()}.json`), JSON.stringify({ completedAt: new Date().toISOString(),
        target: databaseIdentity(targetConnection), restoredTables: Number(tables), applicationStarted: false,
        credentialsUsable: false, filesRestored: false, next: 'Inspect SQL and verify blob references; do not start workers with restored production jobs/connections.' }, null, 2), { flag: 'wx' });
      console.log('Database restored into the isolated rehearsal target. No app started; source files remain in the verified backup. Complete the restore checklist.');
    } finally { await pool.end(); }
    return;
  }
  if (!['plan', 'create'].includes(command) || !opts.sourceEnv) throw Error('BACKUP_SOURCE_ENV_REQUIRED');
  const { parse } = await import('dotenv');
  const sourceEnv = resolve(opts.sourceEnv), env = parse(await readFile(sourceEnv));
  const database = databaseIdentity(env.DATABASE_URL);
  const data = resolve(dirname(sourceEnv), env.DATA_ROOT || '.local/data');
  const sources = [{ label: 'data', path: data }, ...opts.receiptRoots.map((path, index) => ({ label: `receipts-${index + 1}`, path: resolve(path) }))];
  if (command === 'plan') {
    console.log(JSON.stringify({ database, sources, quiesceRequired: true, keyBackupSeparate: true,
      scope: 'Selected data and receipt roots only. Review all journal/manifest/source references before calling it a complete recovery backup.' }, null, 2)); return;
  }
  if (!opts.output) throw Error('BACKUP_OUTPUT_REQUIRED');
  const manifest = await createSnapshot({ output: opts.output, database, sources, quiesced: opts.quiesced,
    dump: file => opts.isolatedDocker ? isolatedDockerPg(opts.isolatedDocker, 'dump', env.DATABASE_URL, file)
      : pgTool(opts.pgDump || 'pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', file], pgEnvironment(env.DATABASE_URL)) });
  console.log(JSON.stringify({ backup: resolve(opts.output), files: manifest.files.length, restoreTested: false, scope: manifest.completeness }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await cli(); }
  catch (error) { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'BACKUP_OPERATION_FAILED'); process.exitCode = 1; }
}
