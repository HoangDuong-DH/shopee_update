import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSupervisorController, newSupervisorState, disableSupervisor } from '../scripts/local-supervisor-policy.mjs';
import { atomicJson, readJson, withRuntimeLock } from '../scripts/runtime-files.mjs';
import { spawnManagedService, inspectManagedClaim, sameSupervisorIdentity, serviceRecipe, supervisorPaths, supervisorIdentity, validateLegacyBuildReceipt } from '../scripts/local-supervisor.mjs';
import { runLocalLauncher, processInfo } from '../scripts/local-launcher.mjs';

const clone = value => structuredClone(value);
function harness(roles = ['api']) {
  let now = 0, starts = 0, lockHeld = false;
  let state = newSupervisorState({ projectRoot: '/fixture', identity: { hash: 'fixture' }, runtimePath: '/fixture/runtime.json', now, policy: { pollMs: 1, baseDelayMs: 10, maxDelayMs: 40, maxRetries: 3, windowMs: 1000 } });
  let runtime = { version: 1, projectRoot: '/fixture', roles: Object.fromEntries(roles.map((role, i) => [role, { pid: i + 100, startedAt: 'creation-' + i }])) };
  const deps = { now: () => now, lock: async fn => { if (lockHeld) return { busy: true }; lockHeld = true; try { return await fn(); } finally { lockHeld = false; } },
    readState: async () => clone(state), writeState: async value => { state = clone(value); }, readRuntime: async () => clone(runtime),
    guard: async () => ({ ok: true }), inspect: async () => ({ kind: 'dead' }), health: async () => true,
    restart: async (role, value) => { starts++; value.roles[role].pid++; value.roles[role].startedAt = 'restart-' + starts; runtime = clone(value); }
  };
  return { deps, controller: createSupervisorController(deps), at: value => { now = value; }, state: () => state, runtime: () => runtime, starts: () => starts };
}
test('dead processes wait for bounded exponential backoff and latch after three attempts in the window', async () => {
  const h = harness();
  for (const time of [0, 9]) { h.at(time); await h.controller.tick(); }
  assert.equal(h.starts(), 0);
  for (const time of [10, 11, 30, 31, 32, 71, 72, 73, 10000]) { h.at(time); await h.controller.tick(); }
  assert.equal(h.starts(), 3); assert.equal(h.state().roles.api.holdReason, 'retry_limit');
  assert.equal(h.state().events.filter(item => item.reason === 'restart_verified').length, 3);
});
test('unknown/unresponsive identity never spawns or kills a process', async () => {
  const h = harness(); h.deps.inspect = async () => ({ kind: 'unknown' });
  for (const time of [0, 1000, 10000]) { h.at(time); await h.controller.tick(); }
  assert.equal(h.starts(), 0); assert.equal(h.state().roles.api.status, 'unknown');
});
test('alive API with failed readiness is degraded, preserving DB outage recovery without restart storm', async () => {
  const h = harness(); h.deps.inspect = async () => ({ kind: 'alive' }); h.deps.health = async () => false;
  for (const time of [0, 1000, 10000]) { h.at(time); await h.controller.tick(); }
  assert.equal(h.starts(), 0); assert.equal(h.state().roles.api.status, 'degraded');
  h.deps.health = async () => true; await h.controller.tick(); assert.equal(h.state().roles.api.status, 'running');
});
test('worker death is held before any queue can be automatically consumed', async () => {
  const h = harness(['worker']); await h.controller.tick(); h.at(10000); await h.controller.tick();
  assert.equal(h.starts(), 0); assert.equal(h.state().roles.worker.holdReason, 'worker_queue_review_required');
});
test('transfer hold prevents automatic recovery of every role', async () => {
  const h = harness(['api', 'web']); h.deps.guard = async () => ({ ok: true, recoveryHeld: true });
  await h.controller.tick(); h.at(10000); await h.controller.tick();
  assert.equal(h.starts(), 0); assert.equal(h.state().roles.api.holdReason, 'transfer_hold');
});
test('changed build/config identity durably disables recovery', async () => {
  const h = harness(); h.deps.guard = async () => ({ ok: false, reason: 'identity_changed' });
  await h.controller.tick(); h.at(10000); await h.controller.tick();
  assert.equal(h.state().enabled, false); assert.equal(h.state().holdReason, 'identity_changed'); assert.equal(h.starts(), 0);
});
test('unavailable configuration holds and does not persist credential-bearing error text', async () => {
  const h = harness(); h.deps.guard = async () => { throw Error('database://user:private-secret command payload'); };
  await h.controller.tick(); assert.equal(h.state().enabled, false); assert.equal(h.state().holdReason, 'configuration_unavailable');
  assert.doesNotMatch(JSON.stringify(h.state()), /private-secret|database:\/\//);
});
test('unverified spawn is latched, retaining the persisted attempt instead of replaying', async () => {
  const h = harness(); h.deps.restart = async () => { throw Error('token=private-secret'); };
  await h.controller.tick(); h.at(10); await h.controller.tick(); h.at(10000); await h.controller.tick();
  assert.equal(h.state().roles.api.attempts.length, 1); assert.equal(h.state().roles.api.holdReason, 'restart_unverified');
  assert.doesNotMatch(JSON.stringify(h.state()), /private-secret/);
});
test('concurrent ticks in one controller do not race through an awaited restart', async () => {
  const h = harness(); await h.controller.tick(); h.at(10);
  let release, entered; const inside = new Promise(done => { entered = done; });
  h.deps.restart = async () => { entered(); await new Promise(done => { release = done; }); };
  const pending = h.controller.tick(); await inside;
  assert.deepEqual(await h.controller.tick(), { busy: true }); release(); await pending;
  assert.equal(h.state().roles.api.attempts.length, 1);
});
test('manual stop is read from durable state before a subsequent tick', async () => {
  const h = harness(); await h.controller.tick();
  await disableSupervisor({ readState: h.deps.readState, writeState: h.deps.writeState, now: 5 });
  h.at(100); assert.deepEqual(await h.controller.tick(), { disabled: true }); assert.equal(h.starts(), 0);
  assert.equal(h.state().events.at(-1).reason, 'manual_stop');
});
test('missing runtime is held, never manufactured from an old receipt', async () => {
  const h = harness(); h.deps.readRuntime = async () => null; await h.controller.tick();
  assert.equal(h.state().enabled, false); assert.equal(h.state().holdReason, 'runtime_unavailable');
});
test('shared filesystem lock serializes stop with ticks across controller instances; atomic writes remain valid', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'listing-supervisor-lock-'));
  try {
    const lock = resolve(directory, 'launch.lock'), path = resolve(directory, 'state.json');
    let entered, release; const inside = new Promise(done => { entered = done; });
    const first = withRuntimeLock(lock, async () => { entered(); await new Promise(done => { release = done; }); await atomicJson(path, { enabled: false }); });
    await inside;
    assert.deepEqual(await withRuntimeLock(lock, async () => { throw Error('must not enter'); }, { skipBusy: true }), { busy: true });
    await assert.rejects(withRuntimeLock(lock, async () => {}), /active|inspection/);
    release(); await first; assert.deepEqual(await readJson(path), { enabled: false });
    await withRuntimeLock(lock, () => atomicJson(path, { enabled: true })); assert.deepEqual(await readJson(path), { enabled: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('supervisor stays outside launcher roles and workers have no recovery recipe', () => {
  const paths = supervisorPaths('/fixture'); assert.notEqual(paths.state, paths.runtime);
  assert.match(paths.state, /supervisor.json$/); assert.throws(() => serviceRecipe('/fixture', 'worker', {}), /held/);
  assert.notEqual(supervisorPaths('/fixture', 'legacy').lock, paths.lock);
});
test('identity compares configuration, source, build and executable independently', () => {
  const identity = { configurationSha256: 'a', sourceSha256: 'b', buildSha256: 'c', executable: 'node' };
  assert.equal(sameSupervisorIdentity(identity, { ...identity }), true);
  for (const key of Object.keys(identity)) assert.equal(sameSupervisorIdentity(identity, { ...identity, [key]: 'changed' }), false);
});
test('owned real child writes sanitized exit reason; wrong token and mismatched creation identity stay unknown', async () => {
  const root = process.cwd(), parent = resolve(root, '.local/supervisor-tests');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, 'owned-child-'));
  let claim;
  try {
    const fixture = resolve(directory, 'fixture.mjs'), marker = resolve(directory, 'exit.marker');
    await writeFile(fixture, `import {existsSync} from 'node:fs'; setInterval(() => {if(existsSync(${JSON.stringify(marker)})) process.exit(7)}, 30);`);
    claim = await spawnManagedService({ root, role: 'fixture', recipe: { file: fixture, args: [fixture] }, env: {}, logs: directory, saveClaim: async () => {} });
    assert.equal((await inspectManagedClaim(claim, root)).kind, 'alive');
    assert.equal((await inspectManagedClaim({ ...claim, token: '0'.repeat(64) }, root)).kind, 'unknown');
    assert.equal((await inspectManagedClaim({ ...claim, startedAt: '2000-01-01T00:00:00.000Z' }, root)).kind, 'unknown');
    assert.equal((await inspectManagedClaim(claim, '/wrong-root')).kind, 'unknown');
    await writeFile(marker, 'exit');
    let result;
    for (let i = 0; i < 30; i++) { result = await inspectManagedClaim(claim, root); if (result.kind === 'dead') break; await new Promise(done => setTimeout(done, 100)); }
    assert.equal(result.kind, 'dead'); assert.equal(result.exitCode, 7); assert.equal(result.exitReason, 'process_exit');
    const exit = await readFile(claim.exitPath, 'utf8'); assert.doesNotMatch(exit, /token|command|environment/); assert.ok(!exit.includes(claim.token));
  } finally {
    if (claim && (await inspectManagedClaim(claim, root)).kind === 'alive') process.kill(claim.pid);
    await rm(directory, { recursive: true, force: true });
  }
});

async function launcherFixture() {
  const root = await mkdtemp(join(tmpdir(), 'listing-launcher-supervisor-'));
  await mkdir(resolve(root, '.local/onboarding'), { recursive: true }); await mkdir(resolve(root, 'apps/web/dist'), { recursive: true }); await writeFile(resolve(root, 'apps/web/dist/index.html'), 'fixture');
  const calls = [], owned = { root, env: { PUBLIC_API_ORIGIN: 'http://127.0.0.1:4430', PUBLIC_WEB_ORIGIN: 'http://127.0.0.1:5273' }, docker: {}, ports: { apiPort: 4430, webPort: 5273, databasePort: 5443 }, identity: { rootHash: 'fixture-root', composeProject: 'fixture' }, receipt: { status: 'complete', configId: 'fixture-config', phases: {}, sourceIdentity: { sourceSha256: 'fixture-source' }, buildIdentity: { sha256: 'fixture-build' } } };
  const adapters = {
    readOwnedConfiguration: async () => owned, sourceIdentity: async () => owned.receipt.sourceIdentity, buildIdentity: async () => owned.receipt.buildIdentity,
    inspectProcesses: async runtime => Object.entries(runtime?.roles ?? {}).map(([role, claim]) => ({ role, claim, actual: claim })),
    readTransferHold: async () => null, portFree: async () => true, inspectOwnedDatabase: async () => ({ exists: true, running: true, healthy: true }), spawnSync: () => ({ status: 0 }),
    json: async (_, path) => path === '/health/ready' ? { status: 'ready' } : { worker: 'online' }, fetch: async () => ({ ok: true }), waitFor: async check => assert.equal(await check(), true),
    stopProcess: pid => { calls.push('stop:' + pid); },
    supervisor: {
      spawnManagedService: async ({ role, recipe, saveClaim, env }) => { calls.push('spawn:' + role); if (role === 'worker') { assert.equal(recipe.file, resolve(root, 'apps/worker/dist/main.js')); assert.deepEqual(recipe.args, [recipe.file]); assert.equal(recipe.config, undefined); } assert.equal(env.SHOPEE_PRODUCTION_WRITES, 'false'); assert.equal(env.PRODUCTION_PILOT_ENABLED, '0'); assert.equal(env.CONNECTION_MAINTENANCE_ENABLED, '0'); await saveClaim({ pid: 100 + calls.length, startedAt: 'fixture', role, command: recipe.file }); },
      enableLocalSupervisor: async () => { calls.push('enable-supervisor'); }, disableLocalSupervisor: async () => { calls.push('disable-supervisor'); }
    }
  };
  return { root, calls, adapters };
}
test('official launcher starts exactly API/worker/web then enables separate supervisor and disables before stopping', async () => {
  const f = await launcherFixture();
  try {
    await runLocalLauncher('start', { root: f.root, noBrowser: true, adapters: f.adapters });
    assert.deepEqual(f.calls, ['spawn:api', 'spawn:worker', 'spawn:web', 'enable-supervisor']);
    const runtime = await readJson(resolve(f.root, '.local/onboarding/runtime.json')); assert.deepEqual(Object.keys(runtime.roles), ['api', 'worker', 'web']);
    f.calls.length = 0; const stopped = await runLocalLauncher('stop', { root: f.root, adapters: f.adapters });
    assert.equal(f.calls[0], 'disable-supervisor'); assert.equal(stopped.stoppedProcesses, 3); assert.equal(stopped.databaseStopped, false);
    assert.deepEqual((await readJson(resolve(f.root, '.local/onboarding/runtime.json'))).roles, {});
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('official transfer launcher keeps worker held and enables supervisor after read-only readiness', async () => {
  const f = await launcherFixture(); f.adapters.readTransferHold = async () => ({ workerAllowed: false }); f.adapters.json = async (_, path) => path === '/health/ready' ? { status: 'ready' } : { worker: 'held', transferReadOnly: true };
  try {
    await runLocalLauncher('start', { root: f.root, noBrowser: true, adapters: f.adapters });
    assert.deepEqual(f.calls, ['spawn:api', 'spawn:web', 'enable-supervisor']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('official stop disables recovery even if later service ownership cannot be proved', async () => {
  const f = await launcherFixture(); f.adapters.inspectProcesses = async () => { throw Error('ownership unavailable'); };
  try {
    await assert.rejects(runLocalLauncher('stop', { root: f.root, adapters: f.adapters }), /ownership/);
    assert.deepEqual(f.calls, ['disable-supervisor']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

import { enableLocalSupervisor, stopSupervisedLegacy } from '../scripts/local-supervisor.mjs';
import { createHash } from 'node:crypto';
import { isReleasePath } from '../scripts/release-package.mjs';
test('release includes every transitively required launcher/supervisor script', () => {
  for (const file of ['runtime-files.mjs', 'local-supervisor-policy.mjs', 'local-supervisor.mjs', 'managed-process.mjs']) assert.equal(isReleasePath('scripts/' + file), true);
});
test('legacy adoption dry-run is read-only; apply owns one separate monitor; repeat reuses; stop disables before killing fixtures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'listing-supervisor-adopt-')), claims = [];
  try {
    for (const dir of ['scripts', 'infra/local', 'packages/persistence/migrations', 'apps/web/dist', 'apps/api/dist', 'apps/worker/dist', 'packages/persistence/dist', '.local/project-start-20261005/logs']) await mkdir(resolve(root, dir), { recursive: true });
    await writeFile(resolve(root, 'package.json'), '{"name":"fixture"}'); await writeFile(resolve(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{"name":"fixture"}}}');
    await writeFile(resolve(root, 'infra/local/compose.yaml'), 'fixture'); await writeFile(resolve(root, 'packages/persistence/migrations/001.sql'), 'fixture');
    for (const file of ['apps/web/dist/index.html', 'apps/api/dist/main.js', 'apps/worker/dist/main.js', 'packages/persistence/dist/index.js']) await writeFile(resolve(root, file), 'fixture');
    await writeFile(resolve(root, 'scripts/managed-process.mjs'), await readFile(resolve('scripts/managed-process.mjs')));
    // This isolated adoption test verifies monitor ownership, never runs real API/worker/DB/HTTP.
    await writeFile(resolve(root, 'scripts/local-supervisor.mjs'), 'setInterval(()=>{},1000);');
    await writeFile(resolve(root, 'scripts/fixture-service.mjs'), 'setInterval(()=>{},1000);');
    const envBytes = 'DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:5442/shopee_uploader\n'; await writeFile(resolve(root, '.env'), envBytes);
    const paths = supervisorPaths(root, 'legacy'), roles = {};
    for (const role of ['api', 'web']) {
      const file = resolve(root, 'scripts/fixture-service.mjs');
      roles[role] = await spawnManagedService({ root, role, recipe: { file, args: [file] }, env: {}, logs: paths.logs, saveClaim: async claim => { claims.push(claim); } });
    }
    await atomicJson(paths.runtime, { version: 1, projectRoot: root, roles, configurationSha256: createHash('sha256').update(envBytes).digest('hex'), productionWrites: false, productionWorkflow: false, connectionMaintenance: false });
    const build = await supervisorIdentity(root);
    await atomicJson(resolve(paths.directory, 'build-receipt.json'), { version: 1, kind: 'listingstudio-tested-local-build', projectRoot: root, sourceSha256: build.sourceSha256, buildSha256: build.buildSha256, executable: process.execPath, verifiedAt: new Date().toISOString() });
    const beforeAdopt = await readJson(paths.runtime);
    await atomicJson(paths.runtime, { ...beforeAdopt, roles: { ...beforeAdopt.roles, worker: { ...roles.api, command: resolve(root, 'apps/worker/src/main.ts') } } });
    await assert.rejects(enableLocalSupervisor({ root, mode: 'legacy', dryRun: true }), /Source worker requires reviewed stop/);
    await atomicJson(paths.runtime, beforeAdopt);
    const dry = await enableLocalSupervisor({ root, mode: 'legacy', dryRun: true }); assert.equal(dry.dryRun, true); assert.deepEqual(dry.ownedServices, ['api', 'web']); assert.equal(await readJson(paths.state), null);
    const result = await enableLocalSupervisor({ root, mode: 'legacy' }); assert.equal(result.enabled, true);
    const state = await readJson(paths.state); claims.push(state.claim); assert.equal((await inspectManagedClaim(state.claim, root)).kind, 'alive'); assert.deepEqual(Object.keys((await readJson(paths.runtime)).roles), ['api', 'web']);
    assert.equal((await enableLocalSupervisor({ root, mode: 'legacy' })).reused, true); assert.equal((await readJson(paths.state)).claim.pid, state.claim.pid);
    await writeFile(resolve(root, 'apps/web/dist/index.html'), 'changed-build');
    await assert.rejects(enableLocalSupervisor({ root, mode: 'legacy' }), /finish stopping|rearming|build receipt/);
    assert.equal((await inspectManagedClaim(roles.api, root)).kind, 'alive');
    const beforeStop = await readJson(paths.runtime);
    await atomicJson(paths.runtime, { ...beforeStop, roles: { ...beforeStop.roles, api: { ...beforeStop.roles.api, token: '0'.repeat(64) } } });
    await assert.rejects(stopSupervisedLegacy(root), /ownership unknown/);
    assert.equal((await readJson(paths.state)).enabled, false);
    assert.equal((await inspectManagedClaim(roles.api, root)).kind, 'alive');
    assert.equal((await inspectManagedClaim(roles.web, root)).kind, 'alive');
    await atomicJson(paths.runtime, beforeStop);
    const stopped = await stopSupervisedLegacy(root); assert.equal(stopped.stoppedProcesses, 2); assert.equal((await readJson(paths.state)).enabled, false);
    assert.deepEqual((await readJson(paths.runtime)).roles, {});
  } finally {
    for (const claim of claims) if ((await inspectManagedClaim(claim, root)).kind === 'alive') { try { process.kill(claim.pid); } catch {} }
    await new Promise(done => setTimeout(done, 100)); await rm(root, { recursive: true, force: true });
  }
});

test('malformed or enlarged retry policy is held before spawning', async () => {
  const h = harness(), state = h.state(); state.policy.maxRetries = 100000;
  await h.deps.writeState(state); await h.controller.tick();
  assert.equal(h.state().enabled, false); assert.equal(h.state().holdReason, 'invalid_recovery_receipt'); assert.equal(h.starts(), 0);
});
test('a new controller reads durable attempt budget and does not reset recovery ceilings', async () => {
  const h = harness(); await h.controller.tick(); h.at(10); await h.controller.tick();
  const second = createSupervisorController(h.deps); h.at(11); await second.tick(); h.at(31); await second.tick(); h.at(32); await second.tick(); h.at(72); await second.tick(); h.at(73); await second.tick();
  assert.equal(h.starts(), 3); assert.equal(h.state().roles.api.holdReason, 'retry_limit');
});

import { pathToFileURL } from 'node:url';
test('actual monitor entry stays alive while parent delays initial claim publication under launch lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'listing-supervisor-publication-'));
  let claim;
  try {
    const paths = supervisorPaths(root, 'legacy');
    await mkdir(paths.logs, { recursive: true }); await mkdir(resolve(root, 'scripts'), { recursive: true });
    await writeFile(resolve(root, 'scripts/managed-process.mjs'), await readFile(resolve('scripts/managed-process.mjs')));
    const file = resolve(root, 'scripts/monitor-fixture.mjs');
    await writeFile(file, `import {runSupervisorMonitor} from ${JSON.stringify(pathToFileURL(resolve('scripts/local-supervisor.mjs')).href)}; await runSupervisorMonitor(process.cwd(), 'legacy');`);
    const state = newSupervisorState({ projectRoot: root, runtimePath: paths.runtime, identity: { configurationSha256: 'fixture', sourceSha256: 'fixture', buildSha256: 'fixture', executable: process.execPath } });
    await atomicJson(paths.state, state);
    await withRuntimeLock(paths.lock, async () => {
      claim = await spawnManagedService({ root, role: 'startup-fixture', recipe: { file, args: [file] }, env: {}, logs: paths.logs,
        saveClaim: async value => {
          claim = value;
          if (!value.startedAt) {
            // Force the child to enter the real monitor before its PID is published.
            await new Promise(done => setTimeout(done, 350));
            assert.equal((await inspectManagedClaim({ ...value, startedAt: value.startedAt }, root)).kind, 'unknown');
            const actual = await processInfo(value);
            assert.equal(actual?.pid, value.pid, 'Monitor must not exit when enabled receipt has not received its claim yet');
          }
          state.claim = value; await atomicJson(paths.state, state);
        } });
      await new Promise(done => setTimeout(done, 120));
      assert.equal((await inspectManagedClaim(claim, root)).kind, 'alive');
      state.enabled = false; await atomicJson(paths.state, state);
    });
  } finally {
    if (claim && (await inspectManagedClaim(claim, root)).kind === 'alive') { try { process.kill(claim.pid); } catch {} }
    await new Promise(done => setTimeout(done, 100)); await rm(root, { recursive: true, force: true });
  }
});

import { waitForSupervisorClaim } from '../scripts/local-supervisor.mjs';
function startupHarness() {
  let elapsed = 0;
  const root = '/startup-fixture', path = '/startup-fixture/runtime.json';
  const state = newSupervisorState({ projectRoot: root, runtimePath: path, identity: { configurationSha256: 'a', sourceSha256: 'b', buildSha256: 'c', executable: process.execPath } });
  return { state, options: { readState: async () => clone(state), projectRoot: root, runtimePath: path, pid: 123, now: () => elapsed,
    sleep: async ms => { elapsed += ms; }, timeoutMs: 500, pollMs: 50 }, elapsed: () => elapsed };
}
test('initial claim publication waits to its bound without starting recovery', async () => {
  const h = startupHarness(); assert.deepEqual(await waitForSupervisorClaim(h.options), { held: true, reason: 'claim_publication_timeout' }); assert.equal(h.elapsed(), 500);
});
test('initial publication accepts only its own PID, preserving another monitor claim', async () => {
  const h = startupHarness(); h.options.sleep = async () => { h.state.claim = { pid: 999 }; };
  assert.deepEqual(await waitForSupervisorClaim(h.options), { held: true, reason: 'claim_changed' }); assert.equal(h.state.claim.pid, 999); assert.equal(h.state.enabled, true);
});
test('changed identity while waiting for parent publication holds without writing', async () => {
  const h = startupHarness(); h.options.sleep = async () => { h.state.identity.buildSha256 = 'changed'; };
  assert.deepEqual(await waitForSupervisorClaim(h.options), { held: true, reason: 'identity_changed' }); assert.equal(h.state.enabled, true);
});
test('manual stop during initial publication prevents any monitor tick', async () => {
  const h = startupHarness(); h.options.sleep = async () => { h.state.enabled = false; };
  assert.deepEqual(await waitForSupervisorClaim(h.options), { disabled: true });
});
test('corrupt per-role retry arrays durably hold instead of running an unbounded budget', async () => {
  const h = harness(); const state = h.state(); state.roles.api = { status: 'backoff', attempts: 'corrupt' }; await h.deps.writeState(state);
  await h.controller.tick(); assert.equal(h.state().enabled, false); assert.equal(h.state().holdReason, 'invalid_recovery_receipt'); assert.equal(h.starts(), 0);
});
test('unreadable runtime and malformed role claims durably hold instead of guessing death', async () => {
  for (const malformed of [null, { version: 1, projectRoot: '/fixture', roles: [] }, { version: 1, projectRoot: '/fixture', roles: { api: { pid: -1 } } }]) {
    const h = harness(); h.deps.readRuntime = async () => malformed; await h.controller.tick(); assert.equal(h.state().enabled, false); assert.equal(h.state().holdReason, 'runtime_unavailable'); assert.equal(h.starts(), 0);
  }
  const h = harness(); h.deps.readRuntime = async () => { throw Error('credential-bearing invalid JSON'); }; await h.controller.tick(); assert.equal(h.state().holdReason, 'runtime_unavailable'); assert.equal(h.state().enabled, false); assert.equal(h.starts(), 0);
});


test('legacy tested build ledger is required and binds fresh source/build/executable before any startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'listing-tested-build-'));
  try {
    const paths = supervisorPaths(root, 'legacy'); await mkdir(paths.directory, { recursive: true });
    const identity = { sourceSha256: 'source', buildSha256: 'build', executable: process.execPath };
    await assert.rejects(validateLegacyBuildReceipt(root, identity), /missing or changed/);
    const receipt = { version: 1, kind: 'listingstudio-tested-local-build', projectRoot: root, ...identity, verifiedAt: new Date().toISOString() };
    await atomicJson(resolve(paths.directory, 'build-receipt.json'), receipt);
    assert.deepEqual(await validateLegacyBuildReceipt(root, identity), identity);
    for (const key of ['sourceSha256', 'buildSha256', 'executable']) await assert.rejects(validateLegacyBuildReceipt(root, { ...identity, [key]: 'changed' }), /missing or changed/);
    await atomicJson(resolve(paths.directory, 'build-receipt.json'), { ...receipt, verifiedAt: 'invalid' });
    await assert.rejects(validateLegacyBuildReceipt(root, identity), /missing or changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('real compiled worker launch clears inherited TypeScript loaders while retaining owned IPC preload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'listing-compiled-worker-')); let claim;
  try {
    const paths = supervisorPaths(root, 'legacy'); await mkdir(paths.logs, { recursive: true }); await mkdir(resolve(root, 'scripts'), { recursive: true }); await mkdir(resolve(root, 'apps/worker/dist'), { recursive: true });
    await writeFile(resolve(root, 'scripts/managed-process.mjs'), await readFile(resolve('scripts/managed-process.mjs')));
    const file = resolve(root, 'apps/worker/dist/main.js');
    await writeFile(file, "console.log(JSON.stringify({execArgv:process.execArgv,tsx:process.env.TSX_TSCONFIG_PATH??null,nodeOptions:process.env.NODE_OPTIONS??null}));setInterval(()=>{},1000);");
    claim = await spawnManagedService({ root, role: 'worker', recipe: { file, args: [file], config: 'must-not-use-tsx-config' }, env: { NODE_OPTIONS: '--import definitely-missing-loader', TSX_TSCONFIG_PATH: 'must-not-use-tsx-config' }, logs: paths.logs, saveClaim: async () => {} });
    assert.equal((await inspectManagedClaim(claim, root)).kind, 'alive');
    const detail = JSON.parse((await readFile(resolve(paths.logs, 'worker.stdout.log'), 'utf8')).trim());
    assert.equal(detail.tsx, null); assert.equal(detail.nodeOptions, null); assert.equal(detail.execArgv.length, 2); assert.equal(detail.execArgv[0], '--import'); assert.match(detail.execArgv[1], /managed-process.mjs$/); assert.doesNotMatch(detail.execArgv.join(' '), /development|tsx/);
  } finally {
    if (claim && (await inspectManagedClaim(claim, root)).kind === 'alive') { try { process.kill(claim.pid); } catch {} }
    await new Promise(done => setTimeout(done, 100)); await rm(root, { recursive: true, force: true });
  }
});

test('official launcher retains and rejects existing source worker before compiled startup reuse', async () => {
  const f = await launcherFixture();
  try {
    await runLocalLauncher('start', { root: f.root, noBrowser: true, adapters: f.adapters });
    const path = resolve(f.root, '.local/onboarding/runtime.json'), runtime = await readJson(path);
    runtime.roles.worker.command = resolve(f.root, 'apps/worker/src/main.ts'); await atomicJson(path, runtime); f.calls.length = 0;
    await assert.rejects(runLocalLauncher('start', { root: f.root, noBrowser: true, adapters: f.adapters }), /source worker requires a reviewed stop/);
    assert.deepEqual(f.calls, []); assert.equal((await readJson(path)).roles.worker.command, runtime.roles.worker.command);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('launcher opt-in renews connections with publication paused and rejects live policy changes', async()=>{
 const f=await launcherFixture(),seen=[];
 try{await writeFile(resolve(f.root,'.local/connection-maintenance.json'),'{"version":1,"enabled":true}');
 f.adapters.supervisor.spawnManagedService=async({role,recipe,saveClaim,env})=>{seen.push({role,renewal:env.CONNECTION_MAINTENANCE_ENABLED,writes:env.SHOPEE_PRODUCTION_WRITES,pilot:env.PRODUCTION_PILOT_ENABLED});await saveClaim({pid:100+seen.length,startedAt:'fixture',role,command:recipe.file});};
 await runLocalLauncher('start',{root:f.root,noBrowser:true,adapters:f.adapters});
 assert.equal(seen.find(x=>x.role==='api').renewal,'1');assert.ok(seen.every(x=>x.writes==='false'&&x.pilot==='0'));
 assert.equal((await readJson(resolve(f.root,'.local/onboarding/runtime.json'))).connectionMaintenance,true);
 await writeFile(resolve(f.root,'.local/connection-maintenance.json'),'{"version":1,"enabled":false}');
 await assert.rejects(runLocalLauncher('start',{root:f.root,noBrowser:true,adapters:f.adapters}),/policy changed/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('transfer hold overrides an existing connection maintenance opt-in',async()=>{
 const f=await launcherFixture();f.adapters.readTransferHold=async()=>({workerAllowed:false});f.adapters.json=async(_,p)=>p==='/health/ready'?{status:'ready'}:{worker:'held',transferReadOnly:true};
 try{await writeFile(resolve(f.root,'.local/connection-maintenance.json'),'{"version":1,"enabled":true}');await runLocalLauncher('start',{root:f.root,noBrowser:true,adapters:f.adapters});assert.equal((await readJson(resolve(f.root,'.local/onboarding/runtime.json'))).connectionMaintenance,false);}
 finally{await rm(f.root,{recursive:true,force:true});}
});
