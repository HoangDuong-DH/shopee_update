import { mkdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const markerName = 'isolated-environment.json';

export function contained(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}

export function validateConfig(config, projectRoot) {
  if (config.version !== 1 || config.mode !== 'isolated' || config.projectRoot !== resolve(projectRoot))
    throw Error('ISOLATED_CONFIG_INVALID');
  const ports = [config.apiPort, config.webPort, config.databasePort];
  if (ports.some(p => !Number.isInteger(p) || p < 1024 || p > 65535 || [4310, 5173, 5442].includes(p)) || new Set(ports).size !== 3)
    throw Error('ISOLATED_PORTS_INVALID');
  if (!contained(resolve(projectRoot, '.local/internal'), config.dataRoot)
    || config.databaseName !== 'shopee_internal_test' || config.databaseUser !== 'shopee_internal')
    throw Error('ISOLATED_TARGET_INVALID');
  return config;
}

export function makeEnvironment(config, secrets, projectRoot, parent = {}) {
  validateConfig(config, projectRoot);
  if (!/^[a-f0-9]{48}$/.test(secrets.databasePassword) || !/^[a-f0-9]{64}$/.test(secrets.encryptionKey))
    throw Error('ISOLATED_SECRETS_INVALID');
  // Deliberately do not inherit live app flags, tokens, Node preloads or proxies.
  const env = {};
  for (const [key, value] of Object.entries(parent)) {
    if (/^(path|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata|programfiles|programfiles\(x86\))$/i.test(key))
      env[key] = value;
  }
  return { ...env, NODE_ENV: 'development', INTERNAL_ISOLATED_MODE: '1',
    DATABASE_URL: `postgres://${config.databaseUser}:${secrets.databasePassword}@127.0.0.1:${config.databasePort}/${config.databaseName}`,
    APP_ENCRYPTION_KEY: secrets.encryptionKey, DATA_ROOT: config.dataRoot,
    API_HOST: '127.0.0.1', API_PORT: String(config.apiPort), WEB_PORT: String(config.webPort),
    ALLOWED_ORIGINS: `http://127.0.0.1:${config.webPort},http://127.0.0.1:${config.apiPort}`,
    PRODUCTION_PILOT_ENABLED: '0', SHOPEE_PRODUCTION_WRITES: 'false', CONNECTION_MAINTENANCE_ENABLED: '0',
    DOTENV_CONFIG_PATH: resolve(projectRoot, '.local/internal/empty.env'), DOTENV_CONFIG_OVERRIDE: 'false' };
}

async function assertNoLinks(path) {
  let current = resolve(path);
  while (true) {
    const stat = await lstat(current).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (stat?.isSymbolicLink()) throw Error('ISOLATED_SYMLINK_TARGET');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}

async function init() {
  const directory = resolve(root, '.local/internal');
  await assertNoLinks(directory);
  await mkdir(directory, { recursive: true });
  // Exclusive marker creation makes rerunning setup fail instead of replacing secrets.
  const config = validateConfig({ version: 1, mode: 'isolated', projectRoot: root,
    apiPort: 4430, webPort: 5273, databasePort: 5443, databaseName: 'shopee_internal_test',
    databaseUser: 'shopee_internal', dataRoot: resolve(directory, 'data') }, root);
  const secret = { databasePassword: randomBytes(24).toString('hex'), encryptionKey: randomBytes(32).toString('hex') };
  await writeFile(resolve(directory, markerName), JSON.stringify(config, null, 2), { flag: 'wx' });
  await writeFile(resolve(directory, 'secrets.json'), JSON.stringify(secret), { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(directory, 'empty.env'), '# Isolated configuration is passed explicitly.\n', { flag: 'wx' });
  await writeFile(resolve(directory, 'docker.env'), `POSTGRES_PASSWORD=${secret.databasePassword}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(directory, 'compose.yaml'), `name: shopee-internal-rehearsal
services:
  postgres:
    image: postgres:17.11-alpine
    environment:
      POSTGRES_USER: shopee_internal
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?Isolated password required}
      POSTGRES_DB: shopee_internal_test
    ports:
      - "127.0.0.1:5443:5432"
    volumes:
      - database:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U shopee_internal -d shopee_internal_test"]
      interval: 3s
      timeout: 3s
      retries: 20
volumes:
  database:
`, { flag: 'wx' });
  await mkdir(config.dataRoot, { recursive: true });
  console.log('Isolated configuration created. API 4430; UI 5273; PostgreSQL 5443. No service started.');
}

export async function readIsolated(projectRoot = root) {
  const directory = resolve(projectRoot, '.local/internal');
  await assertNoLinks(directory);
  const config = validateConfig(JSON.parse(await readFile(resolve(directory, markerName), 'utf8')), projectRoot);
  await assertNoLinks(config.dataRoot);
  const secrets = JSON.parse(await readFile(resolve(directory, 'secrets.json'), 'utf8'));
  return { config, env: makeEnvironment(config, secrets, projectRoot, process.env) };
}

async function freePort(port) {
  await new Promise((ok, fail) => {
    const server = createTcpServer();
    server.once('error', () => fail(Error('ISOLATED_PORT_ALREADY_USED')));
    server.listen(port, '127.0.0.1', () => server.close(ok));
  });
}

async function run(command) {
  const { config, env } = await readIsolated();
  if (command === 'inspect') {
    console.log(JSON.stringify({ ...config, productionWrites: false, automaticRefresh: false, externalFetch: 'blocked', secretValues: 'omitted' }, null, 2)); return;
  }
  for (const [name, directory] of [['domain', 'domain'], ['persistence', 'persistence'], ['gateway', 'shopee'], ['agent-runtime', 'agent-runtime']]) {
    const actual = await realpath(resolve(root, 'node_modules/@shopee', name)).catch(() => null);
    const expected = await realpath(resolve(root, 'packages', directory));
    if (!actual || actual.toLowerCase() !== expected.toLowerCase()) throw Error('ISOLATED_DEPENDENCIES_REQUIRED');
  }
  const preload = pathToFileURL(resolve(root, 'scripts/internal-network-guard.mjs')).href;
  const args = ['--import', preload, '--conditions=development', '--import', 'tsx'];
  if (command === 'migrate') {
    const child = spawn(process.execPath, [...args, 'scripts/migrate.mts'], { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.on('error', () => { process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; }); return;
  }
  if (command !== 'dev') throw Error('UNKNOWN_ISOLATED_COMMAND');
  await freePort(config.apiPort); await freePort(config.webPort);
  // Refuse a restored database with connections: decryption failure alone is not a sandbox.
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    const exists = (await pool.query("SELECT to_regclass('public.connections') AS value")).rows[0].value;
    if (!exists) throw Error('ISOLATED_MIGRATIONS_REQUIRED');
    if (Number((await pool.query('SELECT count(*) FROM connections')).rows[0].count) !== 0)
      throw Error('ISOLATED_CONNECTIONS_MUST_BE_EMPTY');
  } finally { await pool.end(); }
  const { createServer } = await import('vite');
  const vite = await createServer({ configFile: resolve(root, 'apps/web/vite.config.ts'),
    server: { host: '127.0.0.1', port: config.webPort, strictPort: true,
      proxy: { '/v1': `http://127.0.0.1:${config.apiPort}`, '/health': `http://127.0.0.1:${config.apiPort}` } } });
  await vite.listen();
  const children = ['api', 'worker'].map(name => spawn(process.execPath, [...args, `apps/${name}/src/main.ts`], {
    cwd: root, env: { ...env, TSX_TSCONFIG_PATH: resolve(root, `apps/${name}/tsconfig.json`) }, stdio: 'inherit', windowsHide: true }));
  let stopping = false;
  const close = async code => { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGTERM'); await vite.close(); process.exitCode = code; };
  for (const child of children) {
    child.once('error', () => void close(1));
    child.once('exit', code => { if (!stopping) void close(code ?? 1); });
  }
  process.once('SIGINT', () => void close(0)); process.once('SIGTERM', () => void close(0));
  console.log(`Isolated UI: http://127.0.0.1:${config.webPort}. Shopee calls blocked; live services untouched.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const command = process.argv[2]; if (command === 'init') await init(); else await run(command); }
  catch (error) { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'ISOLATED_OPERATION_FAILED'); process.exitCode = 1; }
}
