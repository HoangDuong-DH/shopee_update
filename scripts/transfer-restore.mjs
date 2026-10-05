import { readFile, writeFile, mkdir, readdir, rename, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { noLinks, exists, sha256, loadVerifiedBundle, validateDatabaseInventory, sourceRelative,
  copyVerified, writeExclusive, fileHash, recordFile } from './transfer-files.mjs';
import { readOwnedConfiguration, inspectOwnedDatabase, safeSystemEnvironment, runProcess,
  portAvailable, validateDependencies, safeError } from './onboarding-core.mjs';
import { sourceDatabase, transferPool, inventoryTransferDatabase, inspectTransferContainer } from './transfer-database.mjs';

export const TRANSFER_STATE_PATH = '.local/onboarding/transfer-state.json';
export const TRANSFER_HOLD_PATH = '.local/onboarding/transfer-hold.json';
const PHASES = ['copyFiles', 'restoreDatabase', 'verifyDatabase', 'relocateStorage', 'adoptKey'];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const migrations = rows => rows.map(row => ({ name: row.name, checksum: row.checksum })).sort((a, b) => a.name.localeCompare(b.name));
const identifier = name => { if (!/^[a-z][a-z0-9_]*$/.test(name)) throw Error('TRANSFER_DATABASE_IDENTIFIER_INVALID'); return `"${name}"`; };

export function transferNextAction(code) {
  if (code === 'TRANSFER_REVIEW_REQUIRED' || code === 'TRANSFER_RESTORE_UNKNOWN') return 'Retain the target and its transfer state. Review the database and local receipts before any new restore attempt.';
  if (code === 'TRANSFER_TARGET_DATABASE_NOT_EMPTY' || code === 'TRANSFER_TARGET_DATA_NOT_EMPTY') return 'Use a separate fresh owned installation. Existing data is never overwritten.';
  if (code === 'TRANSFER_MIGRATIONS_MISMATCH') return 'Use the matching source release and complete its fresh local setup before restoring.';
  if (code === 'TRANSFER_TARGET_IN_USE') return 'Stop the verified target application, then repeat the read-only plan.';
  return 'Resolve this check, then repeat the read-only transfer plan. No automatic repair or replay is permitted.';
}
function destination(root, manifest, entry) {
  const [label, ...parts] = entry.path.split('/');
  if (label === 'data') return resolve(root, '.local/data', ...parts);
  if (/^receipts-[1-9][0-9]*$/.test(label)) return resolve(root, '.local/transfer/imports', manifest.bundleId, label, ...parts);
  return null;
}
export function planBlobRelocations(root, manifest) {
  const changes = [];
  for (const blob of manifest.databaseInventory.storagePaths) {
    const candidates = manifest.roots.map(source => ({ source, relative: sourceRelative(source.originalPath, blob.path) })).filter(value => value.relative);
    if (candidates.length !== 1) throw Error('TRANSFER_BLOB_SOURCE_UNMAPPED');
    const { source, relative } = candidates[0];
    const entry = manifest.files.find(file => file.path === `${source.label}/${relative}`);
    if (!entry || entry.sha256 !== blob.sha256 || entry.bytes !== blob.bytes) throw Error('TRANSFER_BLOB_FILE_MISSING');
    const to = destination(root, manifest, entry);
    if (!to) throw Error('TRANSFER_BLOB_SOURCE_UNMAPPED');
    changes.push({ sha256: blob.sha256, bytes: blob.bytes, from: blob.path, to });
  }
  return changes;
}
export async function relocateBlobStorage(client, changes) {
  for (const change of changes) {
    const result = await client.query('UPDATE shop_listing_media_blobs SET storage_path=$1 WHERE sha256=$2 AND storage_path=$3 AND byte_count=$4',
      [change.to, change.sha256, change.from, change.bytes]);
    if (result.rowCount !== 1) throw Error('TRANSFER_BLOB_RELOCATION_MISMATCH');
  }
}
export function filterRestoreList(text, inventory) {
  const tables = new Set(inventory.tables.map(table => table.name)), sequences = new Set(inventory.sequences.map(sequence => sequence.name));
  const seenTables = new Set(), seenSequences = new Set(), selected = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith(';')) continue;
    // The inventory covers only public application tables. Whole-database archives may also contain unrelated schemas.
    const dataObject = line.match(/^\d+; \d+ \d+ (?:TABLE DATA|SEQUENCE SET|MATERIALIZED VIEW DATA) (\S+) /);
    if (dataObject && dataObject[1] !== 'public') continue;
    const match = line.match(/^\d+; \d+ \d+ (TABLE DATA|SEQUENCE SET) public ([a-z][a-z0-9_]*) \S+$/);
    if (!match) {
      if (/; \d+ \d+ (?:TABLE DATA|SEQUENCE SET|MATERIALIZED VIEW DATA) /.test(line)) throw Error('TRANSFER_DUMP_OBJECT_MISMATCH');
      continue;
    }
    const [, type, name] = match, expected = type === 'TABLE DATA' ? tables : sequences, seen = type === 'TABLE DATA' ? seenTables : seenSequences;
    if (!expected.has(name) || seen.has(name)) throw Error('TRANSFER_DUMP_OBJECT_MISMATCH');
    seen.add(name);
    if (name !== 'schema_migrations') selected.push(line);
  }
  if (seenTables.size !== tables.size || seenSequences.size !== sequences.size) throw Error('TRANSFER_DUMP_OBJECT_MISMATCH');
  return selected.join('\n') + '\n';
}
export async function inspectTargetContainer(owned, adapters = {}) {
  const run = adapters.run ?? runProcess;
  const state = await inspectOwnedDatabase(owned, { run });
  if (!state.exists || !state.running || !state.healthy) throw Error('TRANSFER_TARGET_DATABASE_UNAVAILABLE');
  const result = await run({ command: 'docker', args: ['ps', '-q', '--filter', `label=com.docker.compose.project=${owned.identity.composeProject}`, '--filter', 'label=com.docker.compose.service=postgres'],
    cwd: owned.root, env: safeSystemEnvironment(), timeoutMs: 15000 });
  const ids = result.stdout?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (result.exitCode !== 0 || ids.length !== 1 || !/^[a-f0-9]{12,64}$/.test(ids[0])) throw Error('TRANSFER_CONTAINER_IDENTITY_UNVERIFIED');
  return inspectTransferContainer({ container: ids[0], database: sourceDatabase(owned.env.DATABASE_URL), projectRoot: owned.root,
    expectedProject: owned.identity.composeProject, run, target: true });
}
async function readPrivateKeys(bundle) {
  let key, connections;
  try {
    key = JSON.parse(await readFile(resolve(bundle.directory, 'secrets/app-key.json'), 'utf8'));
    connections = JSON.parse(await readFile(resolve(bundle.directory, 'secrets/connection-keys.json'), 'utf8'));
  } catch { throw Error('TRANSFER_PRIVATE_KEYS_INVALID'); }
  if (key?.version !== 1 || !/^[a-f0-9]{64}$/.test(key.APP_ENCRYPTION_KEY ?? '') || connections?.version !== 1 || !Array.isArray(connections.connections))
    throw Error('TRANSFER_PRIVATE_KEYS_INVALID');
  return { key: key.APP_ENCRYPTION_KEY, connections };
}
async function databaseSession(owned, adapters) {
  if (adapters.client) return { client: adapters.client, close: async () => {} };
  await validateDependencies(owned.root);
  const pool = transferPool(owned.env.DATABASE_URL);
  try { const client = await pool.connect(); return { client, close: async () => { client.release(); await pool.end(); } }; }
  catch { await pool.end(); throw Error('TRANSFER_TARGET_DATABASE_UNAVAILABLE'); }
}
async function readDatabase(session, owned, key, adapters) {
  return adapters.readDatabase ? adapters.readDatabase(session.client, key, owned) : inventoryTransferDatabase(session.client, key);
}
async function exclusiveDatabaseClient(client) {
  const others = (await client.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")).rows;
  if (others.length) throw Error('TRANSFER_TARGET_IN_USE');
}
function verifyDatabaseIdentity(result, owned) {
  const actual = result.databaseIdentity, expected = sourceDatabase(owned.env.DATABASE_URL);
  if (!actual || Math.floor(Number(actual.server_version) / 10000) !== 17 || actual.database !== expected.database
    || actual.username !== expected.username || actual.superuser !== true) throw Error('TRANSFER_TARGET_DATABASE_UNVERIFIED');
}
function verifyFreshDatabase(result, manifest, owned) {
  verifyDatabaseIdentity(result, owned); const inventory = validateDatabaseInventory(result.inventory), source = manifest.databaseInventory;
  if (!equal(migrations(inventory.migrations), migrations(source.migrations))
    || !equal(migrations(owned.receipt.sourceIdentity?.migrations ?? []), migrations(source.migrations))) throw Error('TRANSFER_MIGRATIONS_MISMATCH');
  if (!equal(inventory.tables.map(table => table.name).sort(), source.tables.map(table => table.name).sort())
    || !equal(inventory.sequences.map(sequence => sequence.name).sort(), source.sequences.map(sequence => sequence.name).sort())) throw Error('TRANSFER_TARGET_SCHEMA_MISMATCH');
  if (inventory.tables.some(table => table.name !== 'schema_migrations' && table.rowCount !== 0)) throw Error('TRANSFER_TARGET_DATABASE_NOT_EMPTY');
  if (inventory.tables.find(table => table.name === 'schema_migrations').rowCount !== source.migrations.length) throw Error('TRANSFER_MIGRATIONS_MISMATCH');
  return inventory;
}
function verifyImportedDatabase(result, manifest, baseline, { relocated = false, changes = [], privateConnections } = {}) {
  const actual = validateDatabaseInventory(result.inventory), source = manifest.databaseInventory;
  if (!equal(migrations(actual.migrations), migrations(source.migrations))) throw Error('TRANSFER_MIGRATIONS_MISMATCH');
  if (!equal(actual.tables.map(table => table.name).sort(), source.tables.map(table => table.name).sort())) throw Error('TRANSFER_DATABASE_HASH_MISMATCH');
  for (const expected of source.tables) {
    const table = actual.tables.find(row => row.name === expected.name), preserved = baseline.tables.find(row => row.name === 'schema_migrations');
    const wanted = expected.name === 'schema_migrations' ? preserved : expected;
    const projected = relocated && expected.name === 'shop_listing_media_blobs';
    if (table.rowCount !== wanted.rowCount || (projected
      ? !wanted.withoutStoragePathSha256 || table.withoutStoragePathSha256 !== wanted.withoutStoragePathSha256
      : table.sha256 !== wanted.sha256)) throw Error('TRANSFER_DATABASE_HASH_MISMATCH');
  }
  if (!equal(actual.sequences, source.sequences)) throw Error('TRANSFER_SEQUENCE_MISMATCH');
  if (actual.credentials.checkedCiphertexts !== source.credentials.checkedCiphertexts || actual.credentials.keyMatches !== true
    || !equal(result.connectionKeys, privateConnections)) throw Error('TRANSFER_PRIVATE_KEYS_MISMATCH');
  const expectedPaths = relocated ? source.storagePaths.map(path => ({ ...path, path: changes.find(change => change.sha256 === path.sha256).to })) : source.storagePaths;
  if (!equal(actual.storagePaths, expectedPaths)) throw Error('TRANSFER_BLOB_RELOCATION_MISMATCH');
}
async function inspectTarget(root, bundle, keys, adapters) {
  root = resolve(root);
  for (const path of ['.local/data', '.local/transfer', TRANSFER_STATE_PATH, TRANSFER_HOLD_PATH, '.local/onboarding/bootstrap.lock']) await noLinks(resolve(root, path));
  if (await exists(resolve(root, TRANSFER_STATE_PATH)) || await exists(resolve(root, TRANSFER_HOLD_PATH))) throw Error('TRANSFER_REVIEW_REQUIRED');
  if (await exists(resolve(root, '.local/onboarding/bootstrap.lock'))) throw Error('TRANSFER_TARGET_IN_USE');
  const owned = await readOwnedConfiguration(root);
  if (owned.receipt.status !== 'complete' || Object.values(owned.receipt.phases).some(phase => phase.state !== 'complete')) throw Error('TRANSFER_COMPLETE_SETUP_REQUIRED');
  const entries = await readdir(resolve(owned.root, '.local/data')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  if (entries.length) throw Error('TRANSFER_TARGET_DATA_NOT_EMPTY');
  const importRoot = resolve(owned.root, '.local/transfer/imports', bundle.manifest.bundleId);
  if (await exists(importRoot)) throw Error('TRANSFER_REVIEW_REQUIRED');
  for (const port of [owned.ports.apiPort, owned.ports.webPort]) if (!await (adapters.portAvailable ?? portAvailable)(port)) throw Error('TRANSFER_TARGET_IN_USE');
  const inspect = adapters.inspectRuntime ?? (await import('./local-launcher.mjs')).inspectLauncherRuntime;
  const runtime = await inspect(owned);
  if (runtime.owned !== true || runtime.running) throw Error('TRANSFER_TARGET_IN_USE');
  const container = await (adapters.inspectContainer ?? inspectTargetContainer)(owned, adapters);
  const changes = planBlobRelocations(owned.root, bundle.manifest), session = await databaseSession(owned, adapters);
  try {
    await exclusiveDatabaseClient(session.client); await session.client.query("SET TIME ZONE 'UTC'");
    const result = await readDatabase(session, owned, owned.env.APP_ENCRYPTION_KEY, adapters);
    const baseline = verifyFreshDatabase(result, bundle.manifest, owned);
    return { owned, container, changes, baseline, session };
  } catch (error) { await session.close(); throw error; }
}
export async function planTransferBundle(root, options, adapters = {}) {
  const report = { version: 1, mode: 'plan', ready: false, workerAllowed: false, applicationStarted: false, checks: [] };
  let target;
  try {
    const bundle = await loadVerifiedBundle(options.bundle), keys = await readPrivateKeys(bundle);
    report.bundleId = bundle.manifest.bundleId; report.manifestSha256 = bundle.manifestSha256;
    report.checks.push({ id: 'bundle', status: 'ok', code: 'TRANSFER_BUNDLE_VERIFIED' });
    target = await inspectTarget(root, bundle, keys, adapters);
    report.target = { rootHash: target.owned.identity.rootHash, configId: target.owned.receipt.configId, ports: target.owned.ports };
    report.checks.push({ id: 'target', status: 'ok', code: 'TRANSFER_FRESH_TARGET_VERIFIED' });
    report.relocatedBlobCount = target.changes.length; report.verifiedFiles = bundle.manifest.files.length; report.ready = true;
  } catch (error) {
    const code = safeError(error, 'TRANSFER_PLAN_FAILED'); report.checks.push({ id: 'target', status: 'blocked', code, action: transferNextAction(code) });
  } finally { if (target) await target.session.close(); }
  return report;
}
async function saveState(root, state, exclusive = false) {
  const path = resolve(root, TRANSFER_STATE_PATH); await noLinks(path); state.updatedAt = new Date().toISOString();
  if (exclusive) { await mkdir(resolve(root, '.local/onboarding'), { recursive: true }); await writeFile(path, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true }); return; }
  const temp = `${path}.${randomBytes(8).toString('hex')}.pending`; await noLinks(temp);
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true }); await rename(temp, path);
}
async function adoptKey(owned, key, state) {
  const current = await readOwnedConfiguration(owned.root);
  if (!equal(current.receipt.configuration, owned.receipt.configuration) || current.receipt.configId !== owned.receipt.configId) throw Error('TRANSFER_TARGET_CONFIGURATION_CHANGED');
  const envPath = resolve(owned.root, '.env'), receiptPath = resolve(owned.root, '.local/onboarding/receipt.json');
  const app = await readFile(envPath, 'utf8'), beforeReceipt = await readFile(receiptPath, 'utf8');
  const matches = app.match(/^APP_ENCRYPTION_KEY=[a-f0-9]{64}\r?$/gm);
  if (matches?.length !== 1) throw Error('TRANSFER_TARGET_CONFIGURATION_CHANGED');
  const after = app.replace(/^APP_ENCRYPTION_KEY=[a-f0-9]{64}(\r?)$/m, `APP_ENCRYPTION_KEY=${key}$1`);
  const configuration = { ...current.receipt.configuration, appSha256: sha256(after), keySha256: sha256(key) };
  const receipt = { ...current.receipt, configuration, updatedAt: new Date().toISOString(),
    transferAdoption: { bundleId: state.bundleId, manifestSha256: state.manifestSha256, before: current.receipt.configuration,
      after: configuration, changedFields: ['APP_ENCRYPTION_KEY'], adoptedAt: new Date().toISOString() } };
  await writeExclusive(resolve(owned.root, '.local/onboarding/transfer-app-before.env'), app);
  await writeExclusive(resolve(owned.root, '.local/onboarding/transfer-receipt-before.json'), beforeReceipt);
  const pendingEnv = envPath + '.transfer-pending', pendingReceipt = receiptPath + '.transfer-pending';
  await writeExclusive(pendingEnv, after); await writeExclusive(pendingReceipt, JSON.stringify(receipt, null, 2) + '\n');
  await rename(pendingEnv, envPath); await rename(pendingReceipt, receiptPath);
  const verified = await readOwnedConfiguration(owned.root);
  if (!equal(verified.receipt.configuration, configuration) || verified.env.DATABASE_URL !== owned.env.DATABASE_URL || !equal(verified.ports, owned.ports)) throw Error('TRANSFER_TARGET_CONFIGURATION_CHANGED');
  state.configurationAfter = configuration; state.adoptedKeySha256 = configuration.keySha256;
}
export async function restoreTransferBundle(root, options, adapters = {}) {
  if (options.apply !== true) return planTransferBundle(root, options, adapters);
  const bundle = await loadVerifiedBundle(options.bundle), keys = await readPrivateKeys(bundle);
  const target = await inspectTarget(root, bundle, keys, adapters), { owned, session } = target;
  const state = { version: 1, kind: 'listingstudio-transfer-state', bundleId: bundle.manifest.bundleId, manifestSha256: bundle.manifestSha256,
    target: { rootHash: owned.identity.rootHash, configId: owned.receipt.configId }, status: 'preparing', workerAllowed: false,
    configurationBefore: owned.receipt.configuration, phases: Object.fromEntries(PHASES.map(name => [name, { state: 'pending' }])), createdAt: new Date().toISOString() };
  let created = false, verificationTransaction = false;
  try {
    await saveState(owned.root, state, true); created = true;
    await writeExclusive(resolve(owned.root, TRANSFER_HOLD_PATH), JSON.stringify({ version: 1, kind: 'listingstudio-transfer-hold',
      bundleId: state.bundleId, manifestSha256: state.manifestSha256, target: state.target, status: 'held', workerAllowed: false,
      productionWrites: false, productionPilot: false, connectionMaintenance: false, reason: 'restored-data-requires-review', createdAt: state.createdAt }, null, 2) + '\n');
    state.phases.copyFiles.state = 'running'; await saveState(owned.root, state);
    for (const entry of bundle.manifest.files) { const output = destination(owned.root, bundle.manifest, entry); if (output) await copyVerified(resolve(bundle.directory, entry.path), output, entry); }
    await writeExclusive(resolve(owned.root, '.local/transfer/imports', state.bundleId, 'source-root-map.json'), JSON.stringify({ version: 1,
      bundleId: state.bundleId, historyPathsPreserved: true, roots: bundle.manifest.roots.map(source => ({ label: source.label, originalPath: source.originalPath,
        importedPath: source.label === 'data' ? resolve(owned.root, '.local/data') : resolve(owned.root, '.local/transfer/imports', state.bundleId, source.label) })) }, null, 2) + '\n');
    state.phases.copyFiles.state = 'complete'; await saveState(owned.root, state);
    await exclusiveDatabaseClient(session.client);
    await (adapters.inspectContainer ?? inspectTargetContainer)(owned, adapters);
    const fresh = await readDatabase(session, owned, owned.env.APP_ENCRYPTION_KEY, adapters); verifyFreshDatabase(fresh, bundle.manifest, owned);
    const dumpRecord = await recordFile(bundle.directory, 'database.dump'), expectedDump = bundle.manifest.files.find(entry => entry.path === 'database.dump');
    if (dumpRecord.bytes !== expectedDump.bytes || dumpRecord.sha256 !== expectedDump.sha256) throw Error('TRANSFER_CHECKSUM_MISMATCH');
    state.status = 'restore_sent'; state.phases.restoreDatabase.state = 'running'; await saveState(owned.root, state);
    try { await (adapters.restoreDatabase ?? restoreDatabaseDocker)({ owned, container: target.container, bundle, inventory: bundle.manifest.databaseInventory }); }
    catch (error) { state.restoreDiagnostic = safeRestoreDiagnostic(error); state.status = 'restore_unknown'; state.phases.restoreDatabase.state = 'unknown'; await saveState(owned.root, state); throw Error('TRANSFER_RESTORE_UNKNOWN'); }
    state.phases.restoreDatabase.state = 'complete'; state.status = 'restored_unverified'; await saveState(owned.root, state);
    await exclusiveDatabaseClient(session.client);
    await session.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); verificationTransaction = true;
    await session.client.query("SET LOCAL lock_timeout='5s'"); await session.client.query("SET LOCAL TIME ZONE 'UTC'");
    await session.client.query(`LOCK TABLE ${bundle.manifest.databaseInventory.tables.map(table => `public.${identifier(table.name)}`).join(', ')} IN SHARE MODE`);
    state.phases.verifyDatabase.state = 'running'; await saveState(owned.root, state);
    const imported = await readDatabase(session, owned, keys.key, adapters); verifyDatabaseIdentity(imported, owned);
    verifyImportedDatabase(imported, bundle.manifest, target.baseline, { privateConnections: keys.connections });
    state.phases.verifyDatabase.state = 'complete'; await saveState(owned.root, state);
    state.phases.relocateStorage.state = 'running'; await saveState(owned.root, state);
    for (const change of target.changes) if (await fileHash(change.to) !== change.sha256) throw Error('TRANSFER_CHECKSUM_MISMATCH');
    await relocateBlobStorage(session.client, target.changes);
    const relocated = await readDatabase(session, owned, keys.key, adapters);
    verifyImportedDatabase(relocated, bundle.manifest, target.baseline, { relocated: true, changes: target.changes, privateConnections: keys.connections });
    const auditText = JSON.stringify({ version: 1, bundleId: state.bundleId, historicalJsonUnchanged: true, changedTable: 'shop_listing_media_blobs', changedColumn: 'storage_path', changes: target.changes }, null, 2) + '\n';
    await writeExclusive(resolve(owned.root, '.local/onboarding/transfer-relocation.json'), auditText);
    await session.client.query('COMMIT'); verificationTransaction = false;
    await exclusiveDatabaseClient(session.client);
    state.relocationAuditSha256 = sha256(auditText); state.phases.relocateStorage.state = 'complete';
    state.databaseVerification = { verified: true, sourceTablesVerified: bundle.manifest.databaseInventory.tables.length - 1,
      sourceSequencesVerified: bundle.manifest.databaseInventory.sequences.length, preservedTargetMigrationLedger: true,
      checkedCiphertexts: relocated.inventory.credentials.checkedCiphertexts, relocatedBlobCount: target.changes.length };
    await saveState(owned.root, state);
    state.phases.adoptKey.state = 'running'; await saveState(owned.root, state); await adoptKey(owned, keys.key, state);
    state.phases.adoptKey.state = 'complete'; state.status = 'complete'; state.completedAt = new Date().toISOString(); await saveState(owned.root, state);
    return { version: 1, status: 'complete', bundleId: state.bundleId, manifestSha256: state.manifestSha256,
      verifiedFiles: bundle.manifest.files.length, workerAllowed: false, applicationStarted: false, historicalJsonUnchanged: true,
      databaseVerification: state.databaseVerification, action: 'Start the target application in read-only recovery mode. Review old operations and source paths before allowing work.' };
  } catch (error) {
    if (verificationTransaction) await session.client.query('ROLLBACK').catch(() => {});
    if (created && state.status !== 'restore_unknown') { state.status = 'failed'; state.error = safeError(error, 'TRANSFER_RESTORE_FAILED'); await saveState(owned.root, state); }
    if (!created && error.code === 'EEXIST') throw Error('TRANSFER_REVIEW_REQUIRED');
    throw Error(safeError(error, 'TRANSFER_RESTORE_FAILED'));
  } finally { await session.close(); }
}

const RESTORE_STAGES = new Set(['adapter', 'inspect-target', 'dump-list', 'select-public-data', 'prepare-list', 'restore-data']);
const RESTORE_CODES = new Set(['TRANSFER_RESTORE_ADAPTER_FAILED', 'TRANSFER_DATABASE_TOOL_TIMEOUT', 'TRANSFER_DATABASE_TOOL_UNAVAILABLE',
  'TRANSFER_DATABASE_TOOL_FAILED', 'TRANSFER_DUMP_LIST_TOO_LARGE', 'TRANSFER_DUMP_OBJECT_MISMATCH', 'TRANSFER_CONTAINER_IDENTITY_UNVERIFIED']);
const STDERR_CODES = new Set(['NONE', 'POSTGRES_ARCHIVE_VERSION', 'POSTGRES_ARCHIVE_FORMAT', 'POSTGRES_ARCHIVE_INPUT',
  'POSTGRES_PERMISSION_DENIED', 'POSTGRES_DUPLICATE_KEY', 'POSTGRES_FOREIGN_KEY', 'POSTGRES_SCHEMA_MISSING',
  'POSTGRES_RELATION_MISSING', 'POSTGRES_CONFIGURATION_UNSUPPORTED', 'POSTGRES_REPORTED_ERROR']);
export function safeRestoreDiagnostic(error) {
  const input = error?.restoreDiagnostic ?? {}, code = input.code ?? error?.message;
  const result = { stage: RESTORE_STAGES.has(input.stage) ? input.stage : 'adapter',
    code: RESTORE_CODES.has(code) ? code : 'TRANSFER_RESTORE_ADAPTER_FAILED' };
  if (Number.isInteger(input.exitCode) && input.exitCode >= 0 && input.exitCode <= 255) result.exitCode = input.exitCode;
  if (Number.isSafeInteger(input.stderrBytes) && input.stderrBytes >= 0) result.stderrBytes = input.stderrBytes;
  if (/^[a-f0-9]{64}$/.test(input.stderrSha256 ?? '')) result.stderrSha256 = input.stderrSha256;
  if (STDERR_CODES.has(input.stderrCode)) result.stderrCode = input.stderrCode;
  return result;
}
async function restoreStage(stage, operation) {
  try { return await operation(); }
  catch (error) {
    const diagnostic = { ...safeRestoreDiagnostic(error), stage };
    throw Object.assign(Error(diagnostic.code), { restoreDiagnostic: diagnostic });
  }
}
function stderrCode(text) {
  if (!text) return 'NONE';
  if (/unsupported version/i.test(text)) return 'POSTGRES_ARCHIVE_VERSION';
  if (/input file is too short|input file does not appear|not a valid archive/i.test(text)) return 'POSTGRES_ARCHIVE_FORMAT';
  if (/could not read from input/i.test(text)) return 'POSTGRES_ARCHIVE_INPUT';
  if (/permission denied/i.test(text)) return 'POSTGRES_PERMISSION_DENIED';
  if (/duplicate key value/i.test(text)) return 'POSTGRES_DUPLICATE_KEY';
  if (/violates foreign key/i.test(text)) return 'POSTGRES_FOREIGN_KEY';
  if (/schema .*does not exist/i.test(text)) return 'POSTGRES_SCHEMA_MISSING';
  if (/relation .*does not exist/i.test(text)) return 'POSTGRES_RELATION_MISSING';
  if (/unrecognized configuration parameter/i.test(text)) return 'POSTGRES_CONFIGURATION_UNSUPPORTED';
  return 'POSTGRES_REPORTED_ERROR';
}
async function dockerStream(args, { owned, inputFile, inputBytes, capture = false }) {
  const input = inputFile ? await open(inputFile, 'r') : null;
  const url = new URL(owned.env.DATABASE_URL), env = { ...safeSystemEnvironment(), PGPASSWORD: decodeURIComponent(url.password) };
  try {
    return await new Promise((done, fail) => {
      const child = spawn('docker', args, { cwd: owned.root, env, shell: false, windowsHide: true,
        stdio: [input ? input.fd : 'pipe', capture ? 'pipe' : 'ignore', 'pipe'] });
      let result = '', finished = false, stderr = '', stderrBytes = 0;
      const finish = (code, exitCode) => {
        if (finished) return; finished = true; clearTimeout(timer);
        if (!code) { done(result); return; }
        const diagnostic = { stage: 'adapter', code, exitCode, stderrBytes, stderrSha256: sha256(stderr), stderrCode: stderrCode(stderr) };
        fail(Object.assign(Error(code), { restoreDiagnostic: safeRestoreDiagnostic({ restoreDiagnostic: diagnostic }) }));
      };
      const timer = setTimeout(() => { child.kill(); finish('TRANSFER_DATABASE_TOOL_TIMEOUT'); }, 120000);
      child.stderr.on('data', bytes => { if (finished) return; stderrBytes += bytes.length; if (stderr.length < 65536) stderr += bytes.toString('utf8').slice(0, 65536 - stderr.length); });
      child.once('error', () => finish('TRANSFER_DATABASE_TOOL_UNAVAILABLE'));
      child.once('close', code => finish(code === 0 ? null : 'TRANSFER_DATABASE_TOOL_FAILED', code));
      if (capture) child.stdout.on('data', bytes => { result += bytes.toString('utf8'); if (result.length > 4 * 1024 * 1024) { child.kill(); finish('TRANSFER_DUMP_LIST_TOO_LARGE'); } });
      if (!input) { child.stdin.on('error', () => {}); child.stdin.end(inputBytes ?? Buffer.alloc(0)); }
    });
  } finally { if (input) await input.close(); }
}
export async function restoreDatabaseDocker({ owned, container, bundle, inventory }, adapters = {}) {
  const stream = adapters.stream ?? dockerStream;
  const verified = await restoreStage('inspect-target', () => (adapters.inspectContainer ?? inspectTargetContainer)(owned));
  if (verified.container !== container.container) throw Object.assign(Error('TRANSFER_CONTAINER_IDENTITY_UNVERIFIED'),
    { restoreDiagnostic: { stage: 'inspect-target', code: 'TRANSFER_CONTAINER_IDENTITY_UNVERIFIED' } });
  const dump = resolve(bundle.directory, 'database.dump'), source = sourceDatabase(owned.env.DATABASE_URL);
  const list = await restoreStage('dump-list', () => stream(['exec', '-i', verified.container, 'pg_restore', '--list'], { owned, inputFile: dump, capture: true }));
  const selected = await restoreStage('select-public-data', async () => filterRestoreList(list, inventory));
  const path = `/tmp/listingstudio-transfer-${bundle.manifest.bundleId}-${randomBytes(8).toString('hex')}.list`;
  await restoreStage('prepare-list', () => stream(['exec', '-i', verified.container, 'tee', path], { owned, inputBytes: Buffer.from(selected) }));
  try {
    await restoreStage('restore-data', () => stream(['exec', '-i', '-e', 'PGPASSWORD', verified.container, 'pg_restore', '--username', source.username, '--dbname', source.database,
      '--data-only', '--disable-triggers', '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', `--use-list=${path}`], { owned, inputFile: dump }));
  } finally { await stream(['exec', verified.container, 'rm', '--', path], { owned }).catch(() => {}); }
}
