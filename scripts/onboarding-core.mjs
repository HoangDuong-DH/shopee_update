import { mkdir, lstat, readdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_PORTS = { apiPort: 4310, webPort: 5173, databasePort: 5442 };

export async function assertNoLinks(target) {
  let current = resolve(target);
  for (;;) {
    const stat = await lstat(current).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw Error('PATH_UNREADABLE');
    });
    if (stat?.isSymbolicLink()) throw Error('SYMLINK_TARGET');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function exists(target) {
  return lstat(target).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw Error('PATH_UNREADABLE');
  });
}

export function makeConfiguration(ports = DEFAULT_PORTS, ownership = null) {
  const password = randomBytes(24).toString('hex');
  const key = randomBytes(32).toString('hex');
  const env = {
    DATABASE_URL: `postgres://shopee:${password}@127.0.0.1:${ports.databasePort}/shopee_uploader`,
    API_HOST: '127.0.0.1', API_PORT: String(ports.apiPort), WEB_PORT: String(ports.webPort),
    DATA_ROOT: '.local/data', PUBLIC_API_ORIGIN: `http://127.0.0.1:${ports.apiPort}`,
    WEB_ORIGIN: `http://127.0.0.1:${ports.webPort}`,
    PUBLIC_WEB_ORIGIN: `http://127.0.0.1:${ports.webPort}`,
    ALLOWED_ORIGINS: `http://127.0.0.1:${ports.webPort},http://localhost:${ports.webPort},http://127.0.0.1:${ports.apiPort}`,
    PRODUCTION_PILOT_ENABLED: '0', SHOPEE_PRODUCTION_WRITES: 'false', CONNECTION_MAINTENANCE_ENABLED: '0',
    APP_ENCRYPTION_KEY: key,
  };
  const docker = { POSTGRES_PASSWORD: password, POSTGRES_PORT: String(ports.databasePort) };
  if (ownership) Object.assign(docker, { COMPOSE_PROJECT_NAME: ownership.composeProject,
    ONBOARDING_ROOT_HASH: ownership.rootHash, ONBOARDING_CONFIG_ID: ownership.configId });
  const encode = values => Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join('');
  return { env, docker, appText: encode(env), dockerText: encode(docker) };
}

export async function setupLocal(projectRoot) {
  const root = resolve(projectRoot);
  for (const name of ['.env', '.local/docker.env', '.local/data']) await assertNoLinks(resolve(root, name));
  const appExists = await exists(resolve(root, '.env'));
  const dockerExists = await exists(resolve(root, '.local/docker.env'));
  if (appExists && dockerExists) return { created: false, message: 'Existing configuration pair preserved. No service started.' };
  if (dockerExists) throw Error('ORPHAN_DOCKER_ENV');
  if (appExists) throw Error('INCOMPLETE_CONFIGURATION');
  if (await exists(resolve(root, '.local/onboarding/receipt.json'))) throw Error('INCOMPLETE_CONFIGURATION');
  const files = await readdir(resolve(root, '.local/data')).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw Error('DATA_PATH_INVALID');
  });
  if (files.length) throw Error('EXISTING_LOCAL_DATA');
  const config = makeConfiguration();
  await mkdir(resolve(root, '.local'), { recursive: true });
  await writeFile(resolve(root, '.env'), config.appText, { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(root, '.local/docker.env'), config.dockerText, { flag: 'wx', mode: 0o600 });
  await mkdir(resolve(root, '.local/data'), { recursive: true });
  return { created: true, message: 'Local configuration created. Secrets were not printed. No service started.' };
}

export function isMain(moduleUrl) {
  return Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(moduleUrl));
}

import { readFile, realpath, unlink, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { relative, isAbsolute, sep, join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

export const RECEIPT_PATH = '.local/onboarding/receipt.json';
const LOCK_PATH = '.local/onboarding/bootstrap.lock';
const PHASES = ['configuration', 'install', 'database', 'migrations', 'build'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const normalizePath = value => process.platform === 'win32' ? value.toLowerCase() : value;
const contained = (parent, child) => {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export function safeError(error, fallback = 'ONBOARDING_CHECK_FAILED') {
  return typeof error?.message === 'string' && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : fallback;
}

export function validatePorts(options = {}) {
  const ports = Object.fromEntries(Object.entries(DEFAULT_PORTS).map(([key, value]) => [key, options[key] ?? value]));
  if (Object.values(ports).some(port => !Number.isInteger(port) || port < 1024 || port > 65535)
    || new Set(Object.values(ports)).size !== 3) throw Error('PORTS_INVALID');
  return ports;
}

export async function rootIdentity(projectRoot) {
  await assertNoLinks(projectRoot);
  const root = await realpath(resolve(projectRoot));
  const rootHash = sha256(normalizePath(root));
  const composeProject = `shopee-uploader-${rootHash.slice(0, 16)}`;
  return { projectRoot: root, rootHash, composeProject, volumeName: `${composeProject}_database` };
}

export function safeSystemEnvironment(parent = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(parent)) {
    if (/^(path|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata|programfiles|programfiles\(x86\)|pathext|lang|lc_all)$/i.test(key))
      env[key] = value;
  }
  return { ...env, NODE_ENV: 'development', PRODUCTION_PILOT_ENABLED: '0',
    SHOPEE_PRODUCTION_WRITES: 'false', CONNECTION_MAINTENANCE_ENABLED: '0',
    npm_config_audit: 'false', npm_config_fund: 'false' };
}

export function runtimeEnvironment(owned, parent = process.env) {
  return { ...safeSystemEnvironment(parent), ...owned.env,
    DATA_ROOT: resolve(owned.root, '.local/data'),
    PRODUCTION_PILOT_ENABLED: '0', SHOPEE_PRODUCTION_WRITES: 'false', CONNECTION_MAINTENANCE_ENABLED: '0',
    DOTENV_CONFIG_PATH: resolve(owned.root, '.env'), DOTENV_CONFIG_OVERRIDE: 'false' };
}

export function buildEnvironment(env) {
  return { ...env, NODE_ENV: 'production' };
}

export async function runProcess({ command, args, cwd, env, timeoutMs = 30000 }) {
  return new Promise(resolveResult => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', finished = false;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const finish = exitCode => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      resolveResult({ exitCode, stdout, stderr });
    };
    child.stdout.on('data', value => { if (stdout.length < 1024 * 1024) stdout += value; });
    child.stderr.on('data', value => { if (stderr.length < 1024 * 1024) stderr += value; });
    child.once('error', () => finish(1));
    child.once('exit', code => finish(code ?? 1));
  });
}

export async function portAvailable(port) {
  return new Promise(resolveResult => {
    const server = createServer();
    server.once('error', () => resolveResult(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolveResult(true)));
  });
}

async function findNpm() {
  const candidates = [resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const pathValue = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  for (const directory of pathValue.split(process.platform === 'win32' ? ';' : ':').filter(Boolean)) {
    candidates.push(resolve(directory, 'node_modules/npm/bin/npm-cli.js'));
    if (process.platform !== 'win32') candidates.push(resolve(directory, 'npm'));
  }
  for (const file of candidates) if (await exists(file)) return realpath(file);
  throw Error('NPM_UNAVAILABLE');
}

async function listFiles(root, directory, result = []) {
  const absolute = resolve(root, directory);
  const entries = await readdir(absolute, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw Error('SOURCE_UNREADABLE');
  });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (['node_modules', 'dist', '.git', '.local', 'outputs', 'tmp'].includes(entry.name) || entry.name.endsWith('.tsbuildinfo')) continue;
    const name = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw Error('SYMLINK_SOURCE');
    if (entry.isDirectory()) await listFiles(root, name, result);
    else if (entry.isFile()) result.push(name.replaceAll('\\', '/'));
  }
  return result;
}

export async function sourceIdentity(projectRoot) {
  try {
    const packageText = await readFile(resolve(projectRoot, 'package.json'), 'utf8');
    const lockText = await readFile(resolve(projectRoot, 'package-lock.json'), 'utf8');
    const manifest = JSON.parse(packageText), lock = JSON.parse(lockText);
    const lockedRoot = lock.packages?.[''];
    if (!lockedRoot || lock.lockfileVersion !== 3 || manifest.name !== lockedRoot.name
      || JSON.stringify(manifest.dependencies ?? {}) !== JSON.stringify(lockedRoot.dependencies ?? {})
      || JSON.stringify(manifest.devDependencies ?? {}) !== JSON.stringify(lockedRoot.devDependencies ?? {}))
      throw Error('LOCKFILE_MISMATCH');
    const composeText = await readFile(resolve(projectRoot, 'infra/local/compose.yaml'), 'utf8');
    const migrationPaths = (await listFiles(projectRoot, 'packages/persistence/migrations')).filter(name => name.endsWith('.sql')).sort();
    if (!migrationPaths.length) throw Error('MIGRATION_SOURCE_MISSING');
    const migrations = await Promise.all(migrationPaths.map(async name => ({ name: name.split('/').at(-1),
      checksum: sha256(await readFile(resolve(projectRoot, name), 'utf8')) })));
    const paths = ['package.json', 'package-lock.json', 'infra/local/compose.yaml'];
    for (const directory of ['apps', 'packages', 'scripts']) paths.push(...await listFiles(projectRoot, directory));
    for (const entry of await readdir(projectRoot)) if (/^(tsconfig.*\.json|vite.*|vitest.*)$/.test(entry)) paths.push(entry);
    const hashes = await Promise.all([...new Set(paths)].sort().map(async name => `${name}\0${sha256(await readFile(resolve(projectRoot, name)))}\n`));
    return { packageSha256: sha256(packageText), lockfileSha256: sha256(lockText), composeSha256: sha256(composeText),
      sourceSha256: sha256(hashes.join('')), migrations, sourceFileCount: hashes.length };
  } catch (error) { throw Error(safeError(error, 'SOURCE_FILES_REQUIRED')); }
}

export async function validateDependencies(projectRoot) {
  const root = await realpath(projectRoot);
  await assertNoLinks(resolve(root, 'node_modules'));
  if (!await exists(resolve(root, 'node_modules/.package-lock.json'))) throw Error('DEPENDENCIES_REQUIRED');
  let lock, installed;
  try {
    lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
    installed = JSON.parse(await readFile(resolve(root, 'node_modules/.package-lock.json'), 'utf8'));
  } catch { throw Error('DEPENDENCIES_STALE'); }
  if (installed.lockfileVersion !== lock.lockfileVersion) throw Error('DEPENDENCIES_STALE');
  for (const [name, actual] of Object.entries(installed.packages ?? {})) {
    if (name === '') continue;
    const expected = lock.packages?.[name];
    if (!expected || actual.version !== expected.version || actual.integrity !== expected.integrity
      || actual.link !== expected.link || actual.resolved !== expected.resolved) throw Error('DEPENDENCIES_STALE');
  }
  for (const [name, expected] of Object.entries(lock.packages ?? {})) {
    if (name === '' || !name.startsWith('node_modules/')) continue;
    const installedPackage = installed.packages?.[name];
    if (!installedPackage) {
      if (expected.optional) continue;
      throw Error('DEPENDENCIES_STALE');
    }
    const directory = resolve(root, name);
    const actualPath = await realpath(directory).catch(() => null);
    if (!actualPath) throw Error('DEPENDENCIES_STALE');
    if (expected.link) {
      const target = resolve(root, expected.resolved ?? '');
      if (!contained(root, target) || normalizePath(actualPath) !== normalizePath(await realpath(target)))
        throw Error('DEPENDENCIES_DIFFERENT_ROOT');
    } else if (!contained(resolve(root, 'node_modules'), actualPath)) throw Error('DEPENDENCIES_DIFFERENT_ROOT');
    let pkg;
    try { pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')); }
    catch { throw Error('DEPENDENCIES_STALE'); }
    const expectedVersion = expected.link ? lock.packages?.[expected.resolved]?.version : expected.version;
    if (pkg.version !== expectedVersion) throw Error('DEPENDENCIES_STALE');
  }
  return { valid: true };
}

function decodeOwnedEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const found = line.match(/^([A-Z_]+)=(.*)$/);
    if (!found || Object.hasOwn(values, found[1])) throw Error('OWNED_CONFIGURATION_INVALID');
    values[found[1]] = found[2];
  }
  return values;
}

export async function readOwnedConfiguration(projectRoot) {
  const identity = await rootIdentity(projectRoot), root = identity.projectRoot;
  for (const name of ['.env', '.local/docker.env', RECEIPT_PATH, '.local/data']) await assertNoLinks(resolve(root, name));
  let receipt;
  try { receipt = JSON.parse(await readFile(resolve(root, RECEIPT_PATH), 'utf8')); }
  catch { throw Error('OWNERSHIP_RECEIPT_REQUIRED'); }
  if (receipt.version !== 1 || receipt.kind !== 'fresh-local-bootstrap' || receipt.rootHash !== identity.rootHash
    || normalizePath(receipt.projectRoot ?? '') !== normalizePath(root) || receipt.composeProject !== identity.composeProject
    || receipt.volumeName !== identity.volumeName || !/^[a-f0-9]{32}$/.test(receipt.configId ?? '')
    || PHASES.some(name => !['pending', 'running', 'complete', 'failed'].includes(receipt.phases?.[name]?.state)))
    throw Error('OWNERSHIP_RECEIPT_INVALID');
  let appText, dockerText;
  try { [appText, dockerText] = await Promise.all([readFile(resolve(root, '.env'), 'utf8'), readFile(resolve(root, '.local/docker.env'), 'utf8')]); }
  catch { throw Error('INCOMPLETE_CONFIGURATION'); }
  if (sha256(appText) !== receipt.configuration?.appSha256 || sha256(dockerText) !== receipt.configuration?.dockerSha256)
    throw Error('CONFIGURATION_CHANGED');
  const env = decodeOwnedEnv(appText), docker = decodeOwnedEnv(dockerText), ports = validatePorts(receipt.ports);
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { throw Error('OWNED_DATABASE_TARGET_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
    || url.port !== String(ports.databasePort) || url.username !== 'shopee' || url.pathname !== '/shopee_uploader'
    || url.search || url.hash || !/^[a-f0-9]{48}$/.test(url.password) || url.password !== docker.POSTGRES_PASSWORD
    || !/^[a-f0-9]{64}$/.test(env.APP_ENCRYPTION_KEY ?? '') || sha256(env.APP_ENCRYPTION_KEY) !== receipt.configuration.keySha256
    || docker.POSTGRES_PORT !== String(ports.databasePort) || docker.COMPOSE_PROJECT_NAME !== identity.composeProject
    || docker.ONBOARDING_ROOT_HASH !== identity.rootHash || docker.ONBOARDING_CONFIG_ID !== receipt.configId)
    throw Error('OWNED_DATABASE_TARGET_INVALID');
  if (env.API_HOST !== '127.0.0.1' || env.API_PORT !== String(ports.apiPort) || env.WEB_PORT !== String(ports.webPort)
    || env.DATA_ROOT !== '.local/data' || env.PUBLIC_API_ORIGIN !== `http://127.0.0.1:${ports.apiPort}`
    || env.PUBLIC_WEB_ORIGIN !== `http://127.0.0.1:${ports.webPort}`
    || env.WEB_ORIGIN !== `http://127.0.0.1:${ports.webPort}` || env.PRODUCTION_PILOT_ENABLED !== '0'
    || env.SHOPEE_PRODUCTION_WRITES !== 'false' || env.CONNECTION_MAINTENANCE_ENABLED !== '0')
    throw Error('OWNED_CONFIGURATION_INVALID');
  return { root, identity, receipt, ports, env, docker };
}

function nodeSupported(version) {
  const match = version.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  return Boolean(match && Number(match[1]) === 24 && Number(match[2]) >= 20);
}

function check(id, status, code, action, details) {
  return { id, status, code, action, ...(details ? { details } : {}) };
}

export function nextAction(code) {
  const actions = {
    EXISTING_CONFIGURATION: 'Use a separate clean checkout for onboarding. This setup is preserved.',
    ORPHAN_DOCKER_ENV: 'Resolve the existing Docker configuration manually or use a clean checkout.',
    INCOMPLETE_CONFIGURATION: 'Inspect the incomplete setup manually. Secrets are never regenerated automatically.',
    CONFIGURATION_CHANGED: 'Review the changed configuration against its receipt. Do not overwrite or regenerate its key.',
    SOURCE_CHANGED: 'Use a fresh checkout for the updated source, or review the existing environment manually.',
    NODE_VERSION_UNSUPPORTED: 'Install Node.js 24.20.0 or newer within major version 24.',
    NPM_UNAVAILABLE: 'Install npm with the selected Node.js runtime.',
    DOCKER_ENGINE_UNAVAILABLE: 'Install or start Docker Desktop / Docker Engine, then repeat the plan.',
    DOCKER_COMPOSE_UNAVAILABLE: 'Install Docker Compose v2 or newer with support for up --wait.',
    DOCKER_LINUX_ENGINE_REQUIRED: 'Switch Docker Desktop to Linux containers, then repeat the plan.',
    PORTS_INVALID: 'Select three different ports between 1024 and 65535.',
    PORT_OCCUPIED: 'Choose an unused port with --api-port, --web-port or --db-port. Existing services are preserved.',
    DEPENDENCIES_REQUIRED: 'Allow npm ci during setup, or install exact dependencies before developer --skip-install.',
    DEPENDENCIES_STALE: 'Allow npm ci to install the locked dependencies; developer --skip-install requires exact versions.',
    DEPENDENCIES_DIFFERENT_ROOT: 'Use dependencies and workspace links belonging to this exact checkout.',
    SYMLINK_TARGET: 'Use real checkout directories and configuration files, without linked targets.',
    EXISTING_LOCAL_DATA: 'Use a clean checkout. Existing source files and application data are preserved.',
    EXISTING_DOCKER_VOLUME: 'Use a clean checkout or inspect the existing volume manually. It will not be reused or removed.',
    OWNED_VOLUME_MISSING: 'Inspect the missing owned database manually. Setup will not recreate it automatically.',
    DOCKER_OWNERSHIP_MISMATCH: 'Inspect the database ownership manually; no service will be changed.',
    OWNED_DATABASE_STOPPED: 'Start the verified owned database manually, then repeat the read-only plan.',
    MIGRATION_REVIEW_REQUIRED: 'Review the prior migration attempt manually before any further database changes.',
    BOOTSTRAP_BUSY: 'Wait for the current setup, or inspect the lock manually if it was interrupted.',
  };
  return actions[code] ?? 'Resolve this check before retrying setup. No automatic repair was attempted.';
}

export async function inspectOwnedDatabase(owned, adapters = {}) {
  const run = adapters.run ?? runProcess;
  const env = safeSystemEnvironment();
  const execute = args => run({ command: 'docker', args, cwd: owned.root, env, timeoutMs: 15000 });
  const list = await execute(['volume', 'ls', '--format', '{{.Name}}']);
  if (list.exitCode !== 0) throw Error('DOCKER_ENGINE_UNAVAILABLE');
  const found = list.stdout.trim().split(/\r?\n/).includes(owned.identity.volumeName);
  const containers = await execute(['ps', '-aq', '--filter', `label=com.docker.compose.project=${owned.identity.composeProject}`]);
  if (containers.exitCode !== 0) throw Error('DOCKER_ENGINE_UNAVAILABLE');
  const ids = containers.stdout.trim().split(/\s+/).filter(Boolean);
  if (!owned.receipt) {
    if (found || ids.length) throw Error('EXISTING_DOCKER_VOLUME');
    return { exists: false, running: false, healthy: false };
  }
  if (!found) {
    if (owned.receipt.phases.database.state !== 'pending') throw Error('OWNED_VOLUME_MISSING');
    if (ids.length) throw Error('DOCKER_OWNERSHIP_MISMATCH');
    return { exists: false, running: false, healthy: false };
  }
  const result = await execute(['volume', 'inspect', owned.identity.volumeName, '--format', '{{json .Labels}}']);
  let labels;
  try { labels = JSON.parse(result.stdout); } catch { throw Error('DOCKER_OWNERSHIP_MISMATCH'); }
  if (result.exitCode !== 0 || labels?.['com.docker.compose.project'] !== owned.identity.composeProject
    || labels?.['com.docker.compose.volume'] !== 'database'
    || labels?.['com.shopee-uploader.onboarding.root'] !== owned.identity.rootHash
    || labels?.['com.shopee-uploader.onboarding.config'] !== owned.receipt.configId)
    throw Error('DOCKER_OWNERSHIP_MISMATCH');
  if (ids.length > 1) throw Error('DOCKER_OWNERSHIP_MISMATCH');
  if (!ids.length) return { exists: true, running: false, healthy: false };
  const stateResult = await execute(['inspect', ids[0], '--format', '{"labels":{{json .Config.Labels}},"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}},"state":{{json .State}}}']);
  let container;
  try { container = JSON.parse(stateResult.stdout); } catch { throw Error('DOCKER_OWNERSHIP_MISMATCH'); }
  const expectedPort = [{ HostIp: '127.0.0.1', HostPort: String(owned.ports.databasePort) }];
  if (stateResult.exitCode !== 0 || container.labels?.['com.docker.compose.project'] !== owned.identity.composeProject
    || container.labels?.['com.docker.compose.service'] !== 'postgres'
    || container.labels?.['com.shopee-uploader.onboarding.root'] !== owned.identity.rootHash
    || container.labels?.['com.shopee-uploader.onboarding.config'] !== owned.receipt.configId
    || JSON.stringify(container.ports?.['5432/tcp']) !== JSON.stringify(expectedPort)
    || Object.keys(container.ports ?? {}).length !== 1
    || !container.mounts?.some(mount => mount.Type === 'volume' && mount.Name === owned.identity.volumeName && mount.Destination === '/var/lib/postgresql/data'))
    throw Error('DOCKER_OWNERSHIP_MISMATCH');
  return { exists: true, running: container.state?.Running === true, healthy: container.state?.Health?.Status === 'healthy' };
}

export async function inspectOnboarding(projectRoot, options = {}, adapters = {}) {
  const report = { version: 1, mode: 'plan', ready: false, configuration: 'unknown', checks: [], phases: PHASES,
    safety: { productionWrites: false, productionPilot: false, automaticMaintenance: false, autoStart: false } };
  const add = (id, status, code, details) => report.checks.push(check(id, status, code, nextAction(code), details));
  let identity, source, owned, ports;
  try {
    for (const name of ['.env', '.local', '.local/docker.env', '.local/data', '.local/onboarding', RECEIPT_PATH, LOCK_PATH, 'node_modules'])
      await assertNoLinks(resolve(projectRoot, name));
    identity = await rootIdentity(projectRoot);
    add('paths', 'ok', 'PATHS_SAFE');
  } catch (error) { add('paths', 'blocked', safeError(error)); return report; }
  report.projectRoot = identity.projectRoot; report.composeProject = identity.composeProject; report.volumeName = identity.volumeName;
  const root = identity.projectRoot;
  try { ports = validatePorts(options); } catch { add('ports', 'blocked', 'PORTS_INVALID'); return report; }
  try { source = await sourceIdentity(root); report.sourceIdentity = source; add('source', 'ok', 'SOURCE_IDENTIFIED'); }
  catch (error) { add('source', 'blocked', safeError(error)); }
  if (await exists(resolve(root, LOCK_PATH)) && !adapters.lockHeld) add('lock', 'blocked', 'BOOTSTRAP_BUSY');
  const appExists = await exists(resolve(root, '.env')), dockerExists = await exists(resolve(root, '.local/docker.env'));
  const receiptExists = await exists(resolve(root, RECEIPT_PATH));
  if (receiptExists) {
    try {
      owned = await readOwnedConfiguration(root); ports = owned.ports; report.configuration = 'owned';
      if (Object.keys(DEFAULT_PORTS).some(name => options[name] !== undefined && options[name] !== ports[name])) throw Error('CONFIGURATION_CHANGED');
      if (source && owned.receipt.sourceIdentity?.sourceSha256 !== source.sourceSha256) throw Error('SOURCE_CHANGED');
      if (['running', 'failed'].includes(owned.receipt.phases.migrations.state)) throw Error('MIGRATION_REVIEW_REQUIRED');
      add('configuration', 'ok', 'OWNED_CONFIGURATION_VERIFIED');
    } catch (error) { add('configuration', 'blocked', safeError(error)); }
  } else if (appExists) {
    report.configuration = 'existing'; add('configuration', 'blocked', 'EXISTING_CONFIGURATION');
  } else if (dockerExists) {
    report.configuration = 'incomplete'; add('configuration', 'blocked', 'ORPHAN_DOCKER_ENV');
  } else { report.configuration = 'fresh'; add('configuration', 'ok', 'FRESH_CONFIGURATION'); }
  report.ports = ports;
  const nodeVersion = adapters.nodeVersion ?? process.versions.node;
  add('node', nodeSupported(nodeVersion) ? 'ok' : 'blocked', nodeSupported(nodeVersion) ? 'NODE_SUPPORTED' : 'NODE_VERSION_UNSUPPORTED', { version: nodeVersion });
  const run = adapters.run ?? runProcess;
  let npmCli;
  try {
    npmCli = adapters.npmCli ?? await findNpm();
    const npm = await run({ command: process.execPath, args: [npmCli, '--version'], cwd: root, env: safeSystemEnvironment() });
    if (npm.exitCode !== 0 || !/^\d+\.\d+\.\d+/.test(npm.stdout.trim())) throw Error('NPM_UNAVAILABLE');
    add('npm', 'ok', 'NPM_AVAILABLE', { version: npm.stdout.trim().match(/^\d+\.\d+\.\d+/)[0] });
  } catch { add('npm', 'blocked', 'NPM_UNAVAILABLE'); }
  try { await validateDependencies(root); add('dependencies', 'ok', 'DEPENDENCIES_EXACT'); }
  catch (error) {
    const code = safeError(error, 'DEPENDENCIES_STALE');
    add('dependencies', options.skipInstall || options.requireDependencies || code === 'DEPENDENCIES_DIFFERENT_ROOT' || code === 'SYMLINK_TARGET' ? 'blocked' : 'pending', code);
  }
  try {
    const entries = await readdir(resolve(root, '.local/data')).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw Error('DATA_PATH_INVALID');
    });
    if (entries.length && (!owned || owned.receipt.phases.build.state !== 'complete')) throw Error('EXISTING_LOCAL_DATA');
    add('data', 'ok', entries.length ? 'OWNED_LOCAL_DATA' : 'FRESH_LOCAL_DATA');
  } catch (error) { add('data', 'blocked', safeError(error)); }
  let engine = false, database = { exists: false, running: false, healthy: false };
  try {
    const docker = await run({ command: 'docker', args: ['version', '--format', '{{.Server.Version}}'], cwd: root, env: safeSystemEnvironment(), timeoutMs: 15000 });
    if (docker.exitCode !== 0 || !/^\d+\.\d+/.test(docker.stdout.trim())) throw Error('DOCKER_ENGINE_UNAVAILABLE');
    engine = true; add('docker', 'ok', 'DOCKER_ENGINE_AVAILABLE', { version: docker.stdout.trim().match(/^\d+\.\d+(?:\.\d+)?/)[0] });
    const operatingSystem = await run({ command: 'docker', args: ['info', '--format', '{{.OSType}}'], cwd: root, env: safeSystemEnvironment(), timeoutMs: 15000 });
    add('docker-os', operatingSystem.exitCode === 0 && operatingSystem.stdout.trim() === 'linux' ? 'ok' : 'blocked',
      operatingSystem.exitCode === 0 && operatingSystem.stdout.trim() === 'linux' ? 'DOCKER_LINUX_ENGINE' : 'DOCKER_LINUX_ENGINE_REQUIRED');
  } catch { add('docker', 'blocked', 'DOCKER_ENGINE_UNAVAILABLE'); }
  try {
    const compose = await run({ command: 'docker', args: ['compose', 'version', '--short'], cwd: root, env: safeSystemEnvironment(), timeoutMs: 15000 });
    const match = compose.stdout.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
    if (compose.exitCode !== 0 || !match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 20)) throw Error('DOCKER_COMPOSE_UNAVAILABLE');
    add('compose', 'ok', 'DOCKER_COMPOSE_AVAILABLE', { version: match[0] });
  } catch { add('compose', 'blocked', 'DOCKER_COMPOSE_UNAVAILABLE'); }
  if (engine) {
    try {
      database = await inspectOwnedDatabase(owned ?? { root, identity, ports }, { run });
      if (owned?.receipt.phases.database.state === 'complete' && (!database.running || !database.healthy)) throw Error('OWNED_DATABASE_STOPPED');
      add('database', 'ok', database.exists ? 'OWNED_DATABASE_VERIFIED' : 'FRESH_DATABASE', database);
    } catch (error) { add('database', 'blocked', safeError(error)); }
  }
  for (const [name, port] of Object.entries(ports)) {
    const id = name === 'apiPort' ? 'port-api' : name === 'webPort' ? 'port-web' : 'port-database';
    const available = await (adapters.portAvailable ?? portAvailable)(port).catch(() => false);
    const ownDatabase = name === 'databasePort' && owned && database.running;
    add(id, available || ownDatabase ? 'ok' : 'blocked', available ? 'PORT_AVAILABLE' : ownDatabase ? 'OWNED_DATABASE_PORT' : 'PORT_OCCUPIED', { port });
  }
  report.ready = !report.checks.some(value => value.status === 'blocked');
  report.completed = Boolean(owned && owned.receipt.status === 'complete' && PHASES.every(name => owned.receipt.phases[name].state === 'complete'));
  return report;
}


export async function databaseState(owned) {
  // Resolve the driver from this checkout, never a neighbouring operating installation.
  await validateDependencies(owned.root);
  const require = createRequire(resolve(owned.root, 'package.json'));
  let pool;
  try {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: owned.env.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 5000 });
    const identity = (await pool.query('SELECT current_database() AS database, current_user AS username')).rows[0];
    if (identity.database !== 'shopee_uploader' || identity.username !== 'shopee') throw Error('OWNED_DATABASE_TARGET_INVALID');
    const tables = (await pool.query("SELECT CASE WHEN n.nspname='public' THEN c.relname ELSE n.nspname||'.'||c.relname END AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','v','m','f','p') AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' ORDER BY name")).rows.map(row => row.name);
    const migrations = tables.includes('schema_migrations')
      ? (await pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows : [];
    const connectionCount = tables.includes('connections') ? Number((await pool.query('SELECT count(*) FROM connections')).rows[0].count) : 0;
    return { tables, migrations, connectionCount };
  } catch (error) { throw Error(safeError(error, 'OWNED_DATABASE_UNAVAILABLE')); }
  finally { if (pool) await pool.end(); }
}

export async function buildIdentity(projectRoot) {
  const required = ['apps/web/dist/index.html', 'apps/api/dist/main.js', 'apps/worker/dist/main.js', 'packages/persistence/dist/index.js'];
  for (const name of required) {
    await assertNoLinks(resolve(projectRoot, name));
    if (!await exists(resolve(projectRoot, name))) throw Error('BUILD_OUTPUT_MISSING');
  }
  const files = [];
  const collect = async directory => {
    for (const entry of await readdir(resolve(projectRoot, directory), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error('SYMLINK_TARGET');
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(name);
      else if (entry.isFile()) files.push(name);
    }
  };
  for (const directory of ['apps/web/dist', 'apps/api/dist', 'apps/worker/dist', 'packages/domain/dist',
    'packages/persistence/dist', 'packages/shopee/dist', 'packages/agent-runtime/dist']) {
    await assertNoLinks(resolve(projectRoot, directory));
    if (await exists(resolve(projectRoot, directory))) await collect(directory);
  }
  const hashes = await Promise.all(files.sort().map(async name => `${name}\0${sha256(await readFile(resolve(projectRoot, name)))}\n`));
  return { sha256: sha256(hashes.join('')), fileCount: files.length };
}

async function saveReceipt(root, receipt, exclusive = false) {
  const path = resolve(root, RECEIPT_PATH);
  await assertNoLinks(path);
  receipt.updatedAt = new Date().toISOString();
  if (exclusive) {
    await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return;
  }
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

async function createFreshOwned(root, ports, source) {
  const identity = await rootIdentity(root), configId = randomBytes(16).toString('hex');
  const config = makeConfiguration(ports, { ...identity, configId });
  if (await exists(resolve(root, '.env')) || await exists(resolve(root, '.local/docker.env')))
    throw Error('CONFIGURATION_ALREADY_EXISTS');
  const receipt = { version: 1, kind: 'fresh-local-bootstrap', ...identity, configId, ports,
    status: 'incomplete', createdAt: new Date().toISOString(), sourceIdentity: source,
    configuration: { appSha256: sha256(config.appText), dockerSha256: sha256(config.dockerText), keySha256: sha256(config.env.APP_ENCRYPTION_KEY) },
    safety: { productionWrites: false, productionPilot: false, automaticMaintenance: false, autoStart: false },
    phases: Object.fromEntries(PHASES.map(name => [name, { state: 'pending' }])) };
  await saveReceipt(root, receipt, true);
  await writeFile(resolve(root, '.env'), config.appText, { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(root, '.local/docker.env'), config.dockerText, { flag: 'wx', mode: 0o600 });
  await mkdir(resolve(root, '.local/data'), { recursive: true });
  receipt.phases.configuration = { state: 'complete', completedAt: new Date().toISOString() };
  await saveReceipt(root, receipt);
  return readOwnedConfiguration(root);
}

export async function applyOnboarding(projectRoot, options = {}, adapters = {}) {
  const initial = await inspectOnboarding(projectRoot, options, adapters);
  if (!initial.ready) return { version: 1, status: 'blocked', plan: initial };
  if (initial.completed) return { version: 1, status: 'complete', reused: true, ports: initial.ports,
    receiptPath: RECEIPT_PATH, safety: initial.safety };
  const root = initial.projectRoot, lockPath = resolve(root, LOCK_PATH);
  await assertNoLinks(lockPath);
  await mkdir(dirname(lockPath), { recursive: true });
  const lockToken = randomBytes(16).toString('hex');
  try { await writeFile(lockPath, lockToken, { flag: 'wx', mode: 0o600 }); }
  catch { return { version: 1, status: 'blocked', code: 'BOOTSTRAP_BUSY', action: nextAction('BOOTSTRAP_BUSY') }; }
  let owned, activePhase = 'configuration';
  try {
    const plan = await inspectOnboarding(root, options, { ...adapters, lockHeld: true });
    if (!plan.ready) return { version: 1, status: 'blocked', plan };
    owned = plan.configuration === 'owned' ? await readOwnedConfiguration(root) : await createFreshOwned(root, plan.ports, plan.sourceIdentity);
    const receipt = owned.receipt;
    const env = runtimeEnvironment(owned), run = adapters.run ?? runProcess;
    const npmCli = adapters.npmCli ?? await findNpm();
    const command = async (args, commandEnv = env, timeoutMs = 15 * 60 * 1000) => {
      const result = await run({ command: process.execPath, args: [npmCli, ...args], cwd: root, env: commandEnv, timeoutMs });
      if (result.exitCode !== 0) throw Error(`PHASE_${activePhase.toUpperCase()}_FAILED`);
    };
    const phase = async (name, task) => {
      activePhase = name;
      receipt.status = 'incomplete'; receipt.phases[name] = { state: 'running', startedAt: new Date().toISOString() };
      await saveReceipt(root, receipt); adapters.onPhase?.({ phase: name, state: 'running' });
      await task();
      receipt.phases[name] = { ...receipt.phases[name], state: 'complete', completedAt: new Date().toISOString() };
      await saveReceipt(root, receipt); adapters.onPhase?.({ phase: name, state: 'complete' });
    };
    if (receipt.phases.install.state !== 'complete') {
      await phase('install', async () => {
        if (!options.skipInstall) await command(['ci']);
        await validateDependencies(root);
      });
    } else await validateDependencies(root);
    if (receipt.phases.database.state !== 'complete') {
      activePhase = 'database';
      // Verify before recording the impending mutation; a pending phase is the only
      // state permitted to have no volume. Interrupted attempts cannot recreate it.
      const before = await inspectOwnedDatabase(owned, { run });
      const available = await (adapters.portAvailable ?? portAvailable)(owned.ports.databasePort);
      if (!available && !before.running) throw Error('PORT_OCCUPIED');
      await phase('database', async () => {
        const result = await run({ command: 'docker', args: ['compose', '--project-name', owned.identity.composeProject,
          '--env-file', resolve(root, '.local/docker.env'), '--file', resolve(root, 'infra/local/compose.yaml'),
          'up', '--detach', '--wait', '--wait-timeout', '90', 'postgres'], cwd: root,
          env: { ...env, ...owned.docker }, timeoutMs: 5 * 60 * 1000 });
        if (result.exitCode !== 0) throw Error('PHASE_DATABASE_FAILED');
        const after = await inspectOwnedDatabase(owned, { run });
        if (!after.running || !after.healthy) throw Error('OWNED_DATABASE_UNAVAILABLE');
      });
    }
    if (receipt.phases.migrations.state !== 'complete') {
      activePhase = 'migrations';
      const remote = await (adapters.databaseState ?? databaseState)(owned);
      if (remote.tables.length || remote.migrations.length || remote.connectionCount) throw Error('DATABASE_NOT_EMPTY');
      await phase('migrations', async () => {
        await command(['run', 'db:migrate']);
        const after = await (adapters.databaseState ?? databaseState)(owned);
        const expected = receipt.sourceIdentity.migrations;
        if (after.connectionCount !== 0 || after.migrations.length !== expected.length
          || expected.some(row => !after.migrations.some(value => value.name === row.name && value.checksum === row.checksum)))
          throw Error('MIGRATION_READBACK_FAILED');
      });
    }
    if (receipt.phases.build.state !== 'complete') {
      await phase('build', async () => {
        await command(['run', 'build'], buildEnvironment(env));
        receipt.buildIdentity = await buildIdentity(root);
      });
    }
    receipt.status = 'complete'; receipt.completedAt = new Date().toISOString(); await saveReceipt(root, receipt);
    return { version: 1, status: 'complete', reused: false, ports: owned.ports, receiptPath: RECEIPT_PATH,
      sourceIdentity: receipt.sourceIdentity, buildIdentity: receipt.buildIdentity, safety: receipt.safety };
  } catch (error) {
    const code = safeError(error, 'ONBOARDING_APPLY_FAILED');
    if (owned) {
      owned.receipt.status = 'failed';
      owned.receipt.phases[activePhase] = { ...owned.receipt.phases[activePhase], state: 'failed', code, failedAt: new Date().toISOString() };
      await saveReceipt(root, owned.receipt).catch(() => {});
    }
    return { version: 1, status: 'failed', phase: activePhase, code,
      action: activePhase === 'migrations' ? nextAction('MIGRATION_REVIEW_REQUIRED') : 'Resolve the failed local phase, then rerun the same setup command. Existing secrets are preserved.',
      receiptPath: RECEIPT_PATH };
  } finally {
    if (await readFile(lockPath, 'utf8').catch(() => null) === lockToken) await unlink(lockPath);
  }
}

export function parseBootstrapArgs(args) {
  const options = { apply: false, json: false, skipInstall: false };
  const names = { '--api-port': 'apiPort', '--web-port': 'webPort', '--db-port': 'databasePort' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--plan') options.apply = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--skip-install') options.skipInstall = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (Object.hasOwn(names, arg)) {
      const value = args[++index];
      if (!/^\d+$/.test(value ?? '') || Object.hasOwn(options, names[arg])) throw Error('PORTS_INVALID');
      options[names[arg]] = Number(value);
    } else throw Error('UNKNOWN_BOOTSTRAP_ARGUMENT');
  }
  validatePorts(options);
  return options;
}

export function formatPlan(report) {
  const lines = [report.ready ? 'Setup plan is ready.' : 'Setup is blocked; existing files and services are preserved.'];
  for (const item of report.checks) {
    lines.push(`${item.status.toUpperCase()} ${item.id}: ${item.code}${item.details?.port ? ` (${item.details.port})` : ''}`);
    if (item.status === 'blocked' || item.status === 'pending') lines.push(`  ${item.action}`);
  }
  if (report.ready) lines.push(report.completed ? 'This owned setup is already complete.' : 'Run the same command with --apply to create local configuration, install dependencies, prepare the owned database and build.');
  return lines.join('\n');
}

export async function inspectDoctor(projectRoot, options = {}, adapters = {}) {
  const report = await inspectOnboarding(projectRoot, { ...options, requireDependencies: true }, adapters);
  report.mode = 'doctor';
  const add = (id, status, code) => report.checks.push(check(id, status, code, nextAction(code)));
  let owned;
  if (report.configuration === 'owned' && report.completed) {
    owned = await readOwnedConfiguration(projectRoot);
    const busyPorts = report.checks.filter(item => ['port-api', 'port-web'].includes(item.id) && item.code === 'PORT_OCCUPIED');
    if (busyPorts.length) {
      try {
        // The launcher's proof binds PID, executable, absolute command, creation time
        // and health to this configuration. A listener alone never proves ownership.
        const inspect = adapters.inspectRuntime ?? (await import(pathToFileURL(resolve(projectRoot, 'scripts/local-launcher.mjs')).href)).inspectLauncherRuntime;
        const runtime = await inspect(owned);
        if (!runtime.owned || !runtime.running || !runtime.healthy
          || ![owned.ports.apiPort, owned.ports.webPort].every(port => runtime.ports.includes(port))) throw Error('LAUNCH_OWNERSHIP_REQUIRED');
        for (const item of busyPorts) {
          item.status = 'ok'; item.code = 'OWNED_APPLICATION_PORT'; item.action = 'No action needed.';
        }
        add('runtime', 'ok', 'OWNED_RUNTIME_HEALTHY');
      } catch (error) { add('runtime', 'blocked', safeError(error, 'LAUNCH_OWNERSHIP_REQUIRED')); }
    }
  }
  if (report.configuration !== 'owned') {
    add('setup', 'blocked', report.configuration === 'fresh' ? 'SETUP_REQUIRED' : 'EXISTING_CONFIGURATION');
  } else if (!report.completed) add('setup', 'blocked', 'SETUP_INCOMPLETE');
  else if (!report.checks.some(item => item.status === 'blocked')) {
    try {
      const build = await buildIdentity(projectRoot);
      if (build.sha256 !== owned.receipt.buildIdentity?.sha256 || build.fileCount !== owned.receipt.buildIdentity?.fileCount)
        throw Error('BUILD_OUTPUT_CHANGED');
      add('build', 'ok', 'BUILD_VERIFIED');
    } catch (error) { add('build', 'blocked', safeError(error, 'BUILD_NOT_READY')); }
    try {
      const state = await (adapters.databaseState ?? databaseState)(owned), expected = owned.receipt.sourceIdentity.migrations;
      if (state.migrations.length !== expected.length || expected.some(row => !state.migrations.some(value => value.name === row.name && value.checksum === row.checksum)))
        throw Error('MIGRATIONS_NOT_READY');
      add('migrations', 'ok', 'MIGRATIONS_VERIFIED');
    } catch (error) { add('migrations', 'blocked', safeError(error, 'OWNED_DATABASE_UNAVAILABLE')); }
  }
  report.ready = !report.checks.some(item => item.status === 'blocked');
  return report;
}
