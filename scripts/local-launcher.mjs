import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rmdir, unlink } from 'node:fs/promises';
import { openSync, closeSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { readOwnedConfiguration, runtimeEnvironment, inspectOwnedDatabase, assertNoLinks, buildIdentity, sourceIdentity } from './onboarding-core.mjs';

const delay = ms => new Promise(done => setTimeout(done, ms));
const normalized = value => String(value ?? '').replaceAll('\\', '/').toLowerCase();
function commandMatches(command, line) {
  const expected = normalized(command), actual = normalized(line);
  if (!expected) return false;
  let index = actual.indexOf(expected);
  while (index >= 0) {
    const before = index === 0 ? ' ' : actual[index - 1], after = actual[index + expected.length] ?? ' ';
    if (/[\s"']/.test(before) && /[\s"']/.test(after)) return true;
    index = actual.indexOf(expected, index + 1);
  }
  return false;
}
export function matchesOwnedProcess(claim, actual) {
  return Boolean(claim && actual && Number.isInteger(claim.pid) && claim.pid === actual.pid &&
    claim.startedAt && claim.startedAt === actual.startedAt &&
    normalized(claim.executable) === normalized(actual.executable) &&
    commandMatches(claim.command, actual.commandLine));
}
export async function processInfo(claim, { timeoutMs = 1500 } = {}) {
  if (!claim || !Number.isInteger(claim.pid) || claim.pid <= 0 || !claim.pipe || !/^[a-f0-9]{64}$/.test(claim.token ?? '')) throw Error('Invalid managed process identity.');
  const info = await new Promise(done => {
    const socket = createConnection(claim.pipe);
    let data = '', completed = false;
    const finish = value => { if (!completed) { completed = true; clearTimeout(timer); socket.destroy(); done(value); } };
    const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));
    socket.setTimeout(Math.max(1, timeoutMs), () => finish(null));
    socket.once('connect', () => socket.write(claim.token + '\n'));
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.length > 16384) { finish(null); return; }
      if (data.includes('\n')) { try { finish(JSON.parse(data.trim())); } catch { finish(null); } }
    });
    socket.once('error', () => finish(null)); socket.once('end', () => finish(null));
  });
  if (!info) {
    try { process.kill(claim.pid, 0); } catch (error) { if (error.code === 'ESRCH') return null; throw Error('Cannot prove whether the managed process has stopped.'); }
    throw Error('Managed process exists but its ownership channel is unavailable. No process was stopped.');
  }
  return info;
}
export async function waitForOwnedProcess(claim, projectRoot, options = {}) {
  const timeoutMs = options.timeoutMs ?? 25000, pollMs = options.pollMs ?? 200;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) throw Error('Invalid startup wait limit.');
  const read = options.read ?? processInfo, now = options.now ?? (() => performance.now()), sleep = options.sleep ?? delay;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    let actual;
    try { actual = await read(claim, { timeoutMs: Math.min(1500, deadline - now()) }); } catch {}
    if (actual) {
      const creationTimeValid = typeof actual.startedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(actual.startedAt) && Number.isFinite(Date.parse(actual.startedAt));
      const expected = { ...claim, startedAt: claim.startedAt ?? actual.startedAt };
      if (!creationTimeValid || actual.projectRoot !== projectRoot || !matchesOwnedProcess(expected, actual)) {
        throw Object.assign(Error('Started process identity does not match its runtime receipt. All processes were retained. Inspect private logs and the runtime receipt before retrying.'), { code: 'LAUNCH_IDENTITY_MISMATCH' });
      }
      if (now() <= deadline) return actual;
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(pollMs, remaining));
  }
  throw Object.assign(Error('Started process ownership channel was not ready within ' + Math.ceil(timeoutMs / 1000) + ' seconds. Processes and data were retained. Inspect .local/onboarding/logs and runtime.json; run stop:local to stop only verified owned processes before retrying.'), { code: 'LAUNCH_OWNERSHIP_TIMEOUT' });
}
async function portFree(port) {
  return new Promise(done => {
    const server = createServer(); server.once('error', () => done(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => done(true)));
  });
}
async function json(origin, path) {
  try { const result = await fetch(origin + path, { signal: AbortSignal.timeout(2000) }); return result.ok ? await result.json() : null; }
  catch { return null; }
}
async function waitFor(check, message, attempts = 25) {
  for (let index = 0; index < attempts; index++) { if (await check()) return; await delay(1000); }
  throw Error(message);
}
async function readRuntime(owned, path) {
  const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!text) return null;
  const runtime = JSON.parse(text);
  if (runtime.version !== 1 || runtime.projectRoot !== owned.root || runtime.configId !== owned.receipt.configId || runtime.rootHash !== owned.identity.rootHash) throw Error('Runtime receipt belongs to a different configuration.');
  return runtime;
}
async function inspectProcesses(runtime) {
  const results = [];
  for (const [role, claim] of Object.entries(runtime?.roles ?? {})) {
    const actual = await processInfo(claim);
    if (actual && !matchesOwnedProcess(claim.startedAt ? claim : { ...claim, startedAt: actual.startedAt }, actual)) throw Error('Process identity changed; retained all processes. Inspect the runtime receipt.');
    results.push({ role, claim, actual });
  }
  return results;
}
async function saveRuntime(path, runtime) {
  const temp = path + '.pending';
  await writeFile(temp, JSON.stringify(runtime, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const { rename } = await import('node:fs/promises'); await rename(temp, path);
}
export async function readTransferHold(owned) {
  const path = resolve(owned.root, '.local/onboarding/transfer-hold.json');
  await assertNoLinks(path);
  const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (text === null) return null;
  let hold, state;
  try {
    hold = JSON.parse(text);
    const statePath = resolve(owned.root, '.local/onboarding/transfer-state.json');
    await assertNoLinks(statePath);
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch { throw Error('TRANSFER_REVIEW_REQUIRED'); }
  const matches = value => value?.version === 1 && value.target?.rootHash === owned.identity.rootHash
    && value.target?.configId === owned.receipt.configId && /^[a-f0-9]{64}$/.test(value.manifestSha256 ?? '')
    && typeof value.bundleId === 'string' && value.bundleId.length > 0;
  if (!matches(hold) || hold.kind !== 'listingstudio-transfer-hold' || hold.status !== 'held' || hold.workerAllowed !== false
    || !matches(state) || state.kind !== 'listingstudio-transfer-state' || state.status !== 'complete'
    || state.bundleId !== hold.bundleId || state.manifestSha256 !== hold.manifestSha256
    || !['copyFiles','restoreDatabase','verifyDatabase','relocateStorage','adoptKey'].every(key => state.phases?.[key]?.state === 'complete')
    || state.databaseVerification?.verified !== true || state.adoptedKeySha256 !== owned.receipt.configuration.keySha256
    || !['appSha256','dockerSha256','keySha256'].every(key => state.configurationAfter?.[key] === owned.receipt.configuration[key]))
    throw Error('TRANSFER_REVIEW_REQUIRED');
  return hold;
}

export async function inspectLauncherRuntime(owned) {
  const hold = await readTransferHold(owned);
  const expectedRoles = hold ? ['api', 'web'] : ['api', 'worker', 'web'];
  const path = resolve(owned.root, '.local/onboarding/runtime.json');
  await assertNoLinks(path);
  const runtime = await readRuntime(owned, path);
  const processes = await inspectProcesses(runtime);
  const alive = processes.filter(item => item.actual);
  if (!alive.length) return { owned: true, running: false, healthy: false, ports: [] };
  if (alive.length !== expectedRoles.length || !expectedRoles.every(role => alive.some(item => item.role === role))) throw Error('LAUNCH_INCOMPLETE');
  const ready = await json(owned.env.PUBLIC_API_ORIGIN, '/health/ready');
  const status = await json(owned.env.PUBLIC_API_ORIGIN, '/v1/status');
  const web = await fetch(owned.env.PUBLIC_WEB_ORIGIN, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  if (ready?.status !== 'ready' || (hold ? status?.transferReadOnly !== true || status?.worker !== 'held' : status?.worker !== 'online') || !web?.ok) throw Error('LAUNCH_NOT_READY');
  return { owned: true, running: true, healthy: true, recoveryHeld: Boolean(hold), ports: [owned.ports.apiPort, owned.ports.webPort] };
}
export async function runLocalLauncher(action = 'start', options = {}) {
  const root = resolve(options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  if (!['start', 'stop'].includes(action)) throw Error('Usage: local-launcher.mjs start|stop [--no-browser]');
  const owned = await readOwnedConfiguration(root);
  if (owned.receipt.status !== 'complete' || Object.values(owned.receipt.phases).some(phase => phase.state !== 'complete')) throw Error('Setup has not completed. Resume the same bootstrap --apply; do not replace configuration.');
  if (action === 'start') {
    const source = await sourceIdentity(root);
    const build = await buildIdentity(root);
    if (source.sourceSha256 !== owned.receipt.sourceIdentity.sourceSha256 || build.sha256 !== owned.receipt.buildIdentity.sha256) throw Error('Source or build changed since setup. Inspect the build before starting; no service changed.');
  }
  const runtimePath = resolve(root, '.local/onboarding/runtime.json');
  const lock = resolve(root, '.local/onboarding/launch.lock');
  await assertNoLinks(runtimePath); await assertNoLinks(lock);
  try { await mkdir(lock); } catch (error) { if (error.code === 'EEXIST') throw Error('Another launcher is active, or a previous launch needs inspection. No service changed.'); throw error; }
  try {
    await writeFile(resolve(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const previous = await readRuntime(owned, runtimePath);
    const processes = await inspectProcesses(previous);
    const alive = processes.filter(item => item.actual);
    if (action === 'stop') {
      for (const item of alive.reverse()) process.kill(item.claim.pid);
      if (previous) await saveRuntime(runtimePath, { ...previous, roles: {}, stoppedAt: new Date().toISOString() });
      console.log('Application processes stopped. PostgreSQL, source files and database were retained.');
      return { stoppedProcesses: alive.length, databaseStopped: false };
    }
    const hold = await readTransferHold(owned);
    const expectedRoles = hold ? ['api', 'web'] : ['api', 'worker', 'web'];
    const apiOrigin = owned.env.PUBLIC_API_ORIGIN;
    const webOrigin = owned.env.PUBLIC_WEB_ORIGIN;
    if (alive.length) {
      if (alive.length !== expectedRoles.length || !expectedRoles.every(role => alive.some(item => item.role === role))) throw Error('Previous launch is incomplete. Run stop:local to stop only owned processes, then start again.');
      const ready = await json(apiOrigin, '/health/ready'); const status = await json(apiOrigin, '/v1/status');
      if (ready?.status !== 'ready' || (hold ? status?.transferReadOnly !== true || status?.worker !== 'held' : status?.worker !== 'online')) throw Error('Owned processes exist but are not ready. Inspect logs before restarting.');
      console.log('Already running: ' + webOrigin); return { url: webOrigin, reused: true };
    }
    for (const port of [owned.ports.apiPort, owned.ports.webPort]) if (!await portFree(port)) throw Error('A configured application port is occupied. No competing service was started.');
    const database = await inspectOwnedDatabase(owned);
    if (!database.exists) throw Error('Owned database is missing. Inspect setup receipt; launcher will not create a replacement.');
    if (!database.running && !await portFree(owned.ports.databasePort)) throw Error('Database port is occupied by another service.');
    console.log('1/3 Starting the owned database...');
    const result = spawnSync('docker', ['compose', '--project-name', owned.identity.composeProject, '--env-file', resolve(root, '.local/docker.env'), '-f', resolve(root, 'infra/local/compose.yaml'), 'up', '-d', '--wait', '--wait-timeout', '40', 'postgres'], { cwd: root, env: { ...runtimeEnvironment(owned, process.env), ...owned.docker }, encoding: 'utf8', windowsHide: true, timeout: 50000 });
    if (result.status !== 0) throw Error('Docker could not start the owned database. Open Docker Desktop and inspect setup status.');
    const checkedDatabase = await inspectOwnedDatabase(owned); if (!checkedDatabase.healthy) throw Error('Owned database is not healthy. Application was not started.');
    if (!existsSync(resolve(root, 'apps/web/dist/index.html'))) throw Error('Built interface is missing. Resume the same setup before starting.');
    const logs = resolve(root, '.local/onboarding/logs'); await assertNoLinks(logs); await mkdir(logs, { recursive: true });
    const env = runtimeEnvironment(owned, process.env);
    const runtime = { version: 1, projectRoot: root, rootHash: owned.identity.rootHash, configId: owned.receipt.configId, startedAt: new Date().toISOString(), url: webOrigin, roles: {} };
    await saveRuntime(runtimePath, runtime);
    async function start(role, file, args, config) {
      const token = randomBytes(32).toString('hex');
      const pipe = process.platform === 'win32' ? ['', '', '.', 'pipe', 'listingstudio-' + token.slice(0, 32)].join(String.fromCharCode(92)) : resolve(root, '.local/onboarding', role + '-' + token.slice(0, 12) + '.sock');
      const out = openSync(resolve(logs, role + '.stdout.log'), 'a'); const err = openSync(resolve(logs, role + '.stderr.log'), 'a');
      const child = spawn(process.execPath, ['--import', pathToFileURL(resolve(root, 'scripts/managed-process.mjs')).href, ...args], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, err], env: { ...env, LISTINGSTUDIO_LAUNCH_PIPE: pipe, LISTINGSTUDIO_LAUNCH_TOKEN: token, ...(config ? { TSX_TSCONFIG_PATH: resolve(root, config) } : {}) } });
      closeSync(out); closeSync(err);
      await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
      child.unref();
      const claim = { pid: child.pid, executable: process.execPath, command: file, pipe, token, startedAt: null };
      runtime.roles[role] = claim;
      await saveRuntime(runtimePath, runtime);
      const actual = await waitForOwnedProcess(claim, root);
      runtime.roles[role] = { ...claim, startedAt: actual.startedAt };
      await saveRuntime(runtimePath, runtime);
    }
    console.log(hold ? '2/3 Opening the restored workspace for review; worker stays held...' : '2/3 Starting API and import worker...');
    const api = resolve(root, 'apps/api/src/main.ts');
    await start('api', api, ['--conditions=development', '--import', 'tsx', api], 'apps/api/tsconfig.json');
    await waitFor(async () => (await json(apiOrigin, '/health/ready'))?.status === 'ready', 'API not ready. Inspect .local/onboarding/logs; existing data was retained.');
    if (!hold) {
      const worker = resolve(root, 'apps/worker/src/main.ts');
      await start('worker', worker, ['--conditions=development', '--import', 'tsx', worker], 'apps/worker/tsconfig.json');
      await waitFor(async () => (await json(apiOrigin, '/v1/status'))?.worker === 'online', 'Import worker not ready. Inspect private logs.', 15);
    } else {
      const status = await json(apiOrigin, '/v1/status');
      if (status?.transferReadOnly !== true || status?.worker !== 'held') throw Error('TRANSFER_RECOVERY_GUARD_NOT_READY');
    }
    const web = resolve(root, 'node_modules/vite/bin/vite.js');
    await start('web', web, [web, 'preview', '--config', resolve(root, 'apps/web/vite.config.ts'), '--host', '127.0.0.1', '--port', String(owned.ports.webPort), '--strictPort']);
    await waitFor(async () => { try { return (await fetch(webOrigin, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }, 'Web interface not ready. Inspect private logs.', 10);
    console.log('3/3 Ready: ' + webOrigin + (hold ? '\nRestored data is available for review. Editing and workers stay held.' : '\nProduction writes and automatic connection maintenance are disabled.'));
    if (!options.noBrowser) { const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', webOrigin], { detached: true, stdio: 'ignore', windowsHide: true }); browser.unref(); }
    return { url: webOrigin, reused: false };
  } finally {
    await unlink(resolve(lock, 'owner.json')).catch(() => {}); await rmdir(lock);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 2 || args.some((value, index) => index > 0 && value !== '--no-browser')) throw Error('Usage: local-launcher.mjs start|stop [--no-browser]');
    await runLocalLauncher(args[0] ?? 'start', { noBrowser: args.includes('--no-browser') });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
