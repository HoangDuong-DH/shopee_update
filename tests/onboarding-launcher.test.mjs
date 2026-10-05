import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesOwnedProcess } from '../scripts/local-launcher.mjs';

test('launcher only trusts the exact node executable, command path and process creation identity', () => {
  const claim = { pid: 123, executable: 'C:/fresh/node.exe', command: 'C:/fresh/apps/api/src/main.ts', startedAt: '2026-10-02T00:00:00Z' };
  const actual = { pid: 123, executable: 'C:\\fresh\\node.exe', commandLine: '"C:\\fresh\\node.exe" --import tsx "C:\\fresh\\apps\\api\\src\\main.ts"', startedAt: claim.startedAt };
  assert.equal(matchesOwnedProcess(claim, actual), true);
  assert.equal(matchesOwnedProcess(claim, { ...actual, pid: 124 }), false);
  assert.equal(matchesOwnedProcess(claim, { ...actual, startedAt: 'reused-pid' }), false);
  assert.equal(matchesOwnedProcess(claim, { ...actual, executable: 'C:/other/node.exe' }), false);
  assert.equal(matchesOwnedProcess(claim, { ...actual, commandLine: 'C:/other/apps/api/src/main.ts' }), false);
  assert.equal(matchesOwnedProcess(claim, null), false);
});
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTransferHold } from '../scripts/local-launcher.mjs';

test('restored workspace opens only after exact ownership and all restore phases are verified', async () => {
  const root=await mkdtemp(join(tmpdir(),'listingstudio-launch-hold-'));
  const config={appSha256:'a'.repeat(64),dockerSha256:'b'.repeat(64),keySha256:'c'.repeat(64)};
  const owned={root,identity:{rootHash:'root-hash'},receipt:{configId:'config-id',configuration:config}};
  try {
    assert.equal(await readTransferHold(owned),null);
    await mkdir(join(root,'.local/onboarding'),{recursive:true});
    const hold={version:1,kind:'listingstudio-transfer-hold',target:{rootHash:'root-hash',configId:'config-id'},bundleId:'bundle-id',manifestSha256:'d'.repeat(64),status:'held',workerAllowed:false};
    const state={...hold,kind:'listingstudio-transfer-state',status:'complete',configurationAfter:config,adoptedKeySha256:config.keySha256,databaseVerification:{verified:true},phases:Object.fromEntries(['copyFiles','restoreDatabase','verifyDatabase','relocateStorage','adoptKey'].map(x=>[x,{state:'complete'}]))};
    await writeFile(join(root,'.local/onboarding/transfer-hold.json'),JSON.stringify(hold));
    await assert.rejects(readTransferHold(owned),/TRANSFER_REVIEW_REQUIRED/);
    await writeFile(join(root,'.local/onboarding/transfer-state.json'),JSON.stringify(state));
    assert.equal((await readTransferHold(owned)).bundleId,'bundle-id');
    for(const modified of [{...state,status:'restore_sent'},{...state,bundleId:'other'},{...state,configurationAfter:{...config,keySha256:'e'.repeat(64)}},{...state,target:{...state.target,configId:'other'}},{...state,phases:{...state.phases,adoptKey:{state:'failed'}}}]){
      await writeFile(join(root,'.local/onboarding/transfer-state.json'),JSON.stringify(modified));
      await assert.rejects(readTransferHold(owned),/TRANSFER_REVIEW_REQUIRED/);
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});

async function startupApi() {
  const module = await import('../scripts/local-launcher.mjs');
  assert.equal(typeof module.waitForOwnedProcess, 'function', 'Cold startup must wait for authenticated process ownership using a deadline');
  return module;
}
function startupIdentity() {
  const projectRoot = 'C:/fresh', claim = { pid: 123, executable: 'C:/fresh/node.exe', command: 'C:/fresh/apps/api/src/main.ts', pipe: 'fixture-pipe', token: 'a'.repeat(64), startedAt: null };
  const actual = { pid: 123, executable: 'C:/fresh/node.exe', commandLine: 'C:/fresh/node.exe --import tsx C:/fresh/apps/api/src/main.ts', projectRoot, startedAt: '2026-10-02T00:00:00.000Z' };
  return { projectRoot, claim, actual };
}

test('cold authenticated startup succeeds after the former three-second cutoff without changing its process claim', async () => {
  const module = await startupApi(), { claim, actual, projectRoot } = startupIdentity(); let elapsed = 0, reads = 0;
  const result = await module.waitForOwnedProcess(claim, projectRoot, { now: () => elapsed, sleep: async ms => { elapsed += ms; },
    read: async (candidate, options) => {
      assert.equal(candidate, claim); assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 1500); reads++;
      if (elapsed < 8200) throw Error('Managed process exists but its ownership channel is unavailable.');
      return actual;
    } });
  assert.equal(result, actual); assert.equal(elapsed, 8200); assert.ok(reads > 15); assert.equal(claim.startedAt, null);
});

test('startup acquisition never accepts a different pid, root, executable, command or creation identity', async () => {
  const module = await startupApi(), { claim, actual, projectRoot } = startupIdentity();
  const mismatches = [{ ...actual, pid: 124 }, { ...actual, projectRoot: 'C:/other' }, { ...actual, executable: 'C:/other/node.exe' },
    { ...actual, commandLine: 'C:/fresh/node.exe C:/other/apps/api/src/main.ts' }, { ...actual, commandLine: actual.commandLine + '.unowned' },
    { ...actual, startedAt: null }, { ...actual, startedAt: 'not-a-time' }];
  for (const value of mismatches) {
    let reads = 0;
    await assert.rejects(module.waitForOwnedProcess(claim, projectRoot, { now: () => 0, sleep: async () => { throw Error('Should not retry wrong ownership'); },
      read: async () => { reads++; return value; } }), error => error.code === 'LAUNCH_IDENTITY_MISMATCH');
    assert.equal(reads, 1);
  }
  await assert.rejects(module.waitForOwnedProcess({ ...claim, startedAt: '2026-10-01T00:00:00.000Z' }, projectRoot,
    { now: () => 0, read: async () => actual }), error => error.code === 'LAUNCH_IDENTITY_MISMATCH');
});

test('an unavailable authenticated channel fails at the deadline with a bounded final read and actionable guidance', async () => {
  const module = await startupApi(), { claim, projectRoot } = startupIdentity(); let elapsed = 0, reads = 0;
  await assert.rejects(module.waitForOwnedProcess(claim, projectRoot, { timeoutMs: 1000, pollMs: 200, now: () => elapsed,
    sleep: async ms => { elapsed += ms; }, read: async (_claim, options) => { reads++; assert.ok(options.timeoutMs <= 1000 - elapsed); elapsed += options.timeoutMs; throw Error('Ownership channel unavailable'); } }), error => {
      assert.equal(error.code, 'LAUNCH_OWNERSHIP_TIMEOUT'); assert.match(error.message, /logs/); assert.match(error.message, /runtime/); assert.match(error.message, /stop:local/); return true;
    });
  assert.equal(elapsed, 1000); assert.equal(reads, 1); assert.equal(claim.startedAt, null);
});
