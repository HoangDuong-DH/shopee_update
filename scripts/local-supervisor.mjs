import { spawn } from 'node:child_process';
import { open, readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { atomicJson, readJson, withRuntimeLock } from './runtime-files.mjs';
import { createSupervisorController, newSupervisorState, disableSupervisor, validSupervisorReceipt } from './local-supervisor-policy.mjs';
import { readOwnedConfiguration, runtimeEnvironment, safeSystemEnvironment, sourceIdentity, buildIdentity, assertNoLinks } from './onboarding-core.mjs';
import { processInfo, matchesOwnedProcess, waitForOwnedProcess, readTransferHold } from './local-launcher.mjs';

import { readConnectionMaintenancePolicy } from './connection-maintenance-policy.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function supervisorPaths(root, mode = 'onboarding') {
  if (!['onboarding', 'legacy'].includes(mode)) throw Error('Invalid supervisor mode.');
  const directory = resolve(root, mode === 'legacy' ? '.local/project-start-20261005' : '.local/onboarding');
  return { directory, runtime: resolve(directory, 'runtime.json'), state: resolve(directory, 'supervisor.json'), lock: resolve(directory, 'launch.lock'), logs: resolve(directory, 'logs') };
}
export async function supervisorIdentity(root) {
  const [configuration, source, build] = await Promise.all([readFile(resolve(root, '.env')), sourceIdentity(root), buildIdentity(root)]);
  return { maintenancePolicySha256: (await readConnectionMaintenancePolicy(root)).sha256, configurationSha256: hash(configuration), sourceSha256: source.sourceSha256, buildSha256: build.sha256, executable: process.execPath };
}
export async function validateLegacyBuildReceipt(root, identity = null) {
  root = resolve(root);
  const current = identity ?? await supervisorIdentity(root);
  const receipt = await readJson(resolve(root, '.local/project-start-20261005/build-receipt.json'));
  if (!receipt || receipt.version !== 1 || receipt.kind !== 'listingstudio-tested-local-build' || receipt.projectRoot !== root
    || receipt.sourceSha256 !== current.sourceSha256 || receipt.buildSha256 !== current.buildSha256 || receipt.executable !== current.executable
    || typeof receipt.verifiedAt !== 'string' || !Number.isFinite(Date.parse(receipt.verifiedAt))) throw Error('Legacy tested build receipt missing or changed.');
  return current;
}
export function sameSupervisorIdentity(left, right) {
  return (left?.maintenancePolicySha256 ?? 'disabled') === (right?.maintenancePolicySha256 ?? 'disabled') && ['configurationSha256', 'sourceSha256', 'buildSha256', 'executable'].every(key => typeof left?.[key] === 'string' && left[key] === right?.[key]);
}
export async function inspectManagedClaim(claim, root) {
  try {
    const actual = await processInfo(claim);
    if (actual) return { kind: actual.projectRoot === root && claim.startedAt && matchesOwnedProcess(claim, actual) ? 'alive' : 'unknown' };
    let exit = null;
    if (claim.exitPath) {
      try { exit = await readJson(claim.exitPath); } catch {}
    }
    const valid = exit?.pid === claim.pid && exit?.startedAt === claim.startedAt && exit?.projectRoot === root && Number.isInteger(exit?.exitCode);
    return { kind: 'dead', exitCode: valid ? exit.exitCode : null, exitReason: valid ? 'process_exit' : 'exit_unknown' };
  } catch { return { kind: 'unknown' }; }
}
export function serviceRecipe(root, role, ports) {
  if (role === 'api') {
    const file = resolve(root, 'apps/api/src/main.ts');
    return { file, args: ['--conditions=development', '--import', 'tsx', file], config: resolve(root, 'apps/api/tsconfig.json') };
  }
  if (role === 'web') {
    const file = resolve(root, 'node_modules/vite/bin/vite.js');
    return { file, args: [file, 'preview', '--config', resolve(root, 'apps/web/vite.config.ts'), '--host', '127.0.0.1', '--port', String(ports.webPort), '--strictPort'] };
  }
  throw Error('Role is held; no automatic worker or platform mutation recovery.');
}
export async function spawnManagedService({ root, role, recipe, env, logs, saveClaim }) {
  await assertNoLinks(logs); await mkdir(logs, { recursive: true });
  const token = randomBytes(32).toString('hex');
  const pipe = process.platform === 'win32' ? ['','','.','pipe','listingstudio-' + token.slice(0,32)].join(String.fromCharCode(92)) : resolve(logs, role + '-' + token.slice(0,12) + '.sock');
  const exitPath = resolve(logs, role + '-' + token.slice(0,12) + '.exit.json');
  const childEnvironment = { ...env };
  if (role === 'worker') { delete childEnvironment.NODE_OPTIONS; delete childEnvironment.TSX_TSCONFIG_PATH; }
  const stdout = await open(resolve(logs, role + '.stdout.log'), 'a', 0o600);
  let stderr, child;
  try {
    stderr = await open(resolve(logs, role + '.stderr.log'), 'a', 0o600);
    child = spawn(process.execPath, ['--import', pathToFileURL(resolve(root, 'scripts/managed-process.mjs')).href, ...recipe.args], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd],
      env: { ...childEnvironment, PRODUCTION_PILOT_ENABLED: '0', SHOPEE_PRODUCTION_WRITES: 'false', PRODUCTION_WORKFLOW_ENABLED: '0', CONNECTION_MAINTENANCE_ENABLED: role === 'api' && childEnvironment.CONNECTION_MAINTENANCE_ENABLED === '1' ? '1' : '0',
        LISTINGSTUDIO_LAUNCH_PIPE: pipe, LISTINGSTUDIO_LAUNCH_TOKEN: token, LISTINGSTUDIO_LAUNCH_EXIT_PATH: exitPath,
        ...(recipe.config && role !== 'worker' ? { TSX_TSCONFIG_PATH: recipe.config } : {}) }
    });
    await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
    child.unref();
  } finally { await stdout.close(); await stderr?.close(); }
  const claim = { pid: child.pid, executable: process.execPath, command: recipe.file, pipe, token, exitPath, startedAt: null };
  // Persist even before the handshake; timeout is unknown, never an excuse to spawn twice.
  await saveClaim(claim);
  const actual = await waitForOwnedProcess(claim, root);
  const verified = { ...claim, startedAt: actual.startedAt };
  await saveClaim(verified);
  return verified;
}
async function context(root, mode, identity = null) {
  if (mode === 'onboarding') {
    const owned = await readOwnedConfiguration(root);
    if (owned.receipt.status !== 'complete' || Object.values(owned.receipt.phases).some(phase => phase.state !== 'complete')) throw Error('Setup is not complete.');
    const current = identity ?? await supervisorIdentity(root);
    if (current.sourceSha256 !== owned.receipt.sourceIdentity.sourceSha256 || current.buildSha256 !== owned.receipt.buildIdentity.sha256) throw Error('Setup identity changed.');
    const recoveryHeld = Boolean(await readTransferHold(owned));
    const maintenance = await readConnectionMaintenancePolicy(root, {recoveryHeld});
    return { env: { ...runtimeEnvironment(owned), PRODUCTION_WORKFLOW_ENABLED: '0', CONNECTION_MAINTENANCE_ENABLED: maintenance.enabled ? '1' : '0' }, ports: owned.ports, recoveryHeld, owned, identity: current };
  }
  const current = await validateLegacyBuildReceipt(root, identity);
  const { parse } = await import('dotenv');
  const bytes = await readFile(resolve(root, '.env')), saved = parse(bytes), database = new URL(saved.DATABASE_URL);
  if (!['localhost', '127.0.0.1'].includes(database.hostname) || database.port !== '5442' || database.pathname !== '/shopee_uploader') throw Error('Legacy database scope changed.');
  const hold = await readJson(resolve(root, '.local/onboarding/transfer-hold.json'));
  const maintenance = await readConnectionMaintenancePolicy(root, {recoveryHeld:Boolean(hold)});
  return { env: { ...safeSystemEnvironment(), ...saved, NODE_ENV: 'production', API_PORT: '4310', WEB_PORT: '5173', API_HOST: '127.0.0.1',
    PUBLIC_API_ORIGIN: 'http://127.0.0.1:4310', PUBLIC_WEB_ORIGIN: 'http://127.0.0.1:5173', DOTENV_CONFIG_PATH: resolve(root, '.env'), DOTENV_CONFIG_OVERRIDE: 'false', CONNECTION_MAINTENANCE_ENABLED: maintenance.enabled ? '1' : '0' },
    ports: { apiPort: 4310, webPort: 5173 }, recoveryHeld: Boolean(hold), identity: current, configurationSha256: hash(bytes) };
}
function validateRuntime(runtime, root, mode, ctx) {
  if (!runtime || runtime.version !== 1 || runtime.projectRoot !== root || !runtime.roles?.api || !runtime.roles?.web) throw Error('Runtime scope is incomplete.');
  if (runtime.roles.worker && String(runtime.roles.worker.command).replaceAll('\\', '/').toLowerCase() !== resolve(root, 'apps/worker/dist/main.js').replaceAll('\\', '/').toLowerCase()) throw Error('Source worker requires reviewed stop before compiled adoption.');
  if (mode === 'onboarding' && (runtime.configId !== ctx.owned.receipt.configId || runtime.rootHash !== ctx.owned.identity.rootHash)) throw Error('Runtime configuration identity changed.');
  if (mode === 'legacy' && (runtime.configurationSha256 !== ctx.configurationSha256 || runtime.productionWrites !== false || runtime.productionWorkflow !== false || runtime.connectionMaintenance !== (ctx.env.CONNECTION_MAINTENANCE_ENABLED === '1'))) throw Error('Legacy runtime safety receipt changed.');
}
export async function enableLocalSupervisor({ root, mode = 'onboarding', locked = false, dryRun = false }) {
  root = resolve(root); const paths = supervisorPaths(root, mode);
  const operation = async () => {
    const ctx = await context(root, mode), runtime = await readJson(paths.runtime);
    validateRuntime(runtime, root, mode, ctx);
    for (const claim of Object.values(runtime.roles)) if ((await inspectManagedClaim(claim, root)).kind !== 'alive') throw Error('Adoption requires every recorded service to have verified live ownership.');
    const previous = await readJson(paths.state);
    if (previous?.claim) {
      const probe = await inspectManagedClaim(previous.claim, root);
      if (probe.kind === 'unknown') throw Error('Supervisor ownership is unknown; no competing monitor started.');
      if (probe.kind === 'alive') {
        if (!previous.enabled || !sameSupervisorIdentity(previous.identity, ctx.identity)) throw Error('Existing supervisor must finish stopping before rearming.');
        return { reused: true, workerRecovery: 'held' };
      }
    }
    if (dryRun) return { dryRun: true, ownedServices: Object.keys(runtime.roles), recoverableRoles: ['api', 'web'], workerRecovery: 'held', productionWrites: false };
    const state = newSupervisorState({ projectRoot: root, runtimePath: paths.runtime, identity: ctx.identity });
    if (previous?.enabled && sameSupervisorIdentity(previous.identity, ctx.identity)) {
      state.roles = previous.roles; state.events = previous.events;
    }
    await atomicJson(paths.state, state);
    const file = resolve(root, 'scripts/local-supervisor.mjs');
    state.claim = await spawnManagedService({ root, role: 'supervisor', recipe: { file, args: [file, 'monitor', '--mode', mode] },
      env: safeSystemEnvironment(), logs: paths.logs, saveClaim: async claim => { state.claim = claim; await atomicJson(paths.state, state); } });
    return { enabled: true, workerRecovery: 'held' };
  };
  return locked ? operation() : withRuntimeLock(paths.lock, operation);
}
export async function disableLocalSupervisor(root, mode = 'onboarding') {
  // Caller must hold this mode's launch.lock. Disabling is durable before any kill.
  const paths = supervisorPaths(root, mode);
  await disableSupervisor({ readState: () => readJson(paths.state), writeState: state => atomicJson(paths.state, state) });
  const state = await readJson(paths.state);
  if (state?.claim && state.claim.pid !== process.pid && (await inspectManagedClaim(state.claim, root)).kind === 'alive') {
    try { process.kill(state.claim.pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
export async function waitForSupervisorClaim({ readState, projectRoot, runtimePath, pid = process.pid, now = () => performance.now(), sleep = ms => new Promise(done => setTimeout(done, ms)), timeoutMs = 25000, pollMs = 50 }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000 || !Number.isFinite(pollMs) || pollMs <= 0) throw Error('Invalid supervisor startup limit.');
  const deadline = now() + timeoutMs;
  let initial = null;
  while (now() < deadline) {
    let state;
    try { state = await readState(); } catch { return { held: true, reason: 'receipt_unavailable' }; }
    if (!state?.enabled) return { disabled: true };
    if (!validSupervisorReceipt(state) || state.version !== 1 || state.kind !== 'listingstudio-local-supervisor' || state.projectRoot !== projectRoot || state.runtimePath !== runtimePath || !state.identity) return { held: true, reason: 'receipt_changed' };
    if (!initial) initial = { identity: { ...state.identity }, createdAt: state.createdAt };
    if (initial.createdAt !== state.createdAt || !sameSupervisorIdentity(initial.identity, state.identity)) return { held: true, reason: 'identity_changed' };
    if (state.claim) return state.claim.pid === pid ? { owned: true } : { held: true, reason: 'claim_changed' };
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(pollMs, remaining));
  }
  return { held: true, reason: 'claim_publication_timeout' };
}
export async function runSupervisorMonitor(root, mode) {
  const paths = supervisorPaths(root, mode);
  // The parent publishes the claim after spawn; no recovery action is allowed first.
  const startup = await waitForSupervisorClaim({ readState: () => readJson(paths.state), projectRoot: root, runtimePath: paths.runtime });
  if (!startup.owned) {
    if (startup.held) throw Error('Supervisor startup held: ' + startup.reason);
    return;
  }
  let tickContext = null;
  const controller = createSupervisorController({
    lock: operation => withRuntimeLock(paths.lock, operation, { skipBusy: true }),
    readState: () => readJson(paths.state), writeState: state => atomicJson(paths.state, state), readRuntime: () => readJson(paths.runtime),
    guard: async state => {
      const currentIdentity = await supervisorIdentity(root);
      if (!sameSupervisorIdentity(state.identity, currentIdentity)) return { ok: false, reason: 'identity_changed' };
      const ctx = await context(root, mode, currentIdentity);
      if (mode === 'legacy' && ctx.configurationSha256 !== currentIdentity.configurationSha256) return { ok: false, reason: 'identity_changed' };
      if (!sameSupervisorIdentity(state.identity, ctx.identity)) return { ok: false, reason: 'identity_changed' };
      const runtime = await readJson(paths.runtime); validateRuntime(runtime, root, mode, ctx);
      tickContext = ctx;
      return { ok: true, recoveryHeld: ctx.recoveryHeld };
    },
    inspect: inspectManagedClaim,
    health: async role => {
      if (role === 'worker') return true;
      const ctx = tickContext, url = role === 'api' ? ctx.env.PUBLIC_API_ORIGIN + '/health/ready' : ctx.env.PUBLIC_WEB_ORIGIN;
      try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); return response.ok && (role !== 'api' || (await response.json()).status === 'ready'); } catch { return false; }
    },
    restart: async (role, runtime) => {
      const ctx = await context(root, mode);
      const state = await readJson(paths.state);
      if (!state?.enabled || !sameSupervisorIdentity(state.identity, ctx.identity) || ctx.recoveryHeld || (await inspectManagedClaim(runtime.roles[role], root)).kind !== 'dead') throw Error('Recovery guard changed.');
      await spawnManagedService({ root, role, recipe: serviceRecipe(root, role, ctx.ports), env: ctx.env, logs: paths.logs,
        saveClaim: async claim => { runtime.roles[role] = claim; await atomicJson(paths.runtime, runtime); } });
    }
  });
  while (true) {
    const state = await readJson(paths.state);
    if (!state?.enabled || state.claim?.pid !== process.pid) return;
    try { await controller.tick(); } catch {
      // Do not write outside the lock or log exception data; failure is retried as inspection.
      console.error('Supervisor inspection failed; services retained.');
    }
    await new Promise(done => setTimeout(done, 5000));
  }
}
export async function stopSupervisedLegacy(root) {
  root = resolve(root); const paths = supervisorPaths(root, 'legacy');
  return withRuntimeLock(paths.lock, async () => {
    await disableLocalSupervisor(root, 'legacy');
    const runtime = await readJson(paths.runtime);
    if (!runtime || runtime.projectRoot !== root) throw Error('Legacy runtime ownership unavailable. Supervisor disabled; services retained.');
    const claims = Object.values(runtime.roles ?? {}), alive = [];
    for (const claim of claims) {
      const result = await inspectManagedClaim(claim, root);
      if (result.kind === 'unknown') throw Error('Service ownership unknown. Supervisor disabled; services retained.');
      if (result.kind === 'alive') alive.push(claim);
    }
    for (const claim of alive.reverse()) process.kill(claim.pid);
    await atomicJson(paths.runtime, { ...runtime, roles: {}, stoppedAt: new Date().toISOString() });
    return { stoppedProcesses: alive.length, databaseStopped: false };
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), action = args[0], modeIndex = args.indexOf('--mode'), mode = modeIndex >= 0 ? args[modeIndex + 1] : 'onboarding';
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    if (!['monitor', 'adopt', 'stop'].includes(action) || !['onboarding', 'legacy'].includes(mode) || args.some((arg, index) => index > 0 && arg !== '--apply' && arg !== '--mode' && index !== modeIndex + 1)) throw Error('Usage: local-supervisor.mjs adopt|stop --mode legacy [--apply]');
    if (action === 'monitor') await runSupervisorMonitor(root, mode);
    else if (action === 'adopt') console.log(JSON.stringify(await enableLocalSupervisor({ root, mode, dryRun: !args.includes('--apply') })));
    else if (mode === 'legacy' && args.includes('--apply')) console.log(JSON.stringify(await stopSupervisedLegacy(root)));
    else throw Error('Use stop:local for onboarding, or stop --mode legacy --apply.');
  } catch { console.error('Supervisor action held. Inspect owned runtime, configuration and private logs; no unknown process was stopped.'); process.exitCode = 1; }
}
