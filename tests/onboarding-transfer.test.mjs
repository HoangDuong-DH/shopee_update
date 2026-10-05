import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const roots = [];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
after(async () => {
  for (const root of roots) {
    if (dirname(root) !== resolve(tmpdir()) || !root.includes('listingstudio-transfer-test-')) throw Error('UNSAFE_TEST_CLEANUP');
    await rm(root, { recursive: true, force: true });
  }
});
async function api() {
  const module = await import('../scripts/transfer-local.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof module.createTransferBundle, 'function', 'Private transfer export must exist');
  return module;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'listingstudio-transfer-test-')); roots.push(root);
  const sourceRoot = join(root, 'source'), dataRoot = join(sourceRoot, '.local/data');
  await mkdir(dataRoot, { recursive: true });
  await writeFile(join(dataRoot, 'source.png'), 'immutable-original-image');
  const inventory = { version: 1, postgresMajor: 17,
    migrations: [{ name: '001.sql', checksum: digest('fixture migration') }],
    tables: [{ name: 'schema_migrations', rowCount: 1, sha256: '1'.repeat(64) },
      { name: 'products', rowCount: 2, sha256: '2'.repeat(64) },
      { name: 'jobs', rowCount: 3, sha256: '3'.repeat(64) }],
    sequences: [{ name: 'job_events_id_seq', lastValue: '9', isCalled: true }],
    storagePaths: [], credentials: { checkedCiphertexts: 0, keyMatches: true } };
  const source = { projectRoot: sourceRoot, dataRoot, connectionString: 'postgres://shopee:source-password@127.0.0.1:5442/shopee_uploader',
    database: { host: '127.0.0.1', port: 5442, database: 'shopee_uploader', username: 'shopee' }, appEncryptionKey: 'b'.repeat(64) };
  const output = join(root, 'bundle');
  const options = { output, source, sources: [{ label: 'data', path: dataRoot }], quiesced: true,
    dump: async path => writeFile(path, Buffer.concat([Buffer.from('PGDMP'), Buffer.from('fixture custom dump')])),
    readDatabase: async () => structuredClone(inventory) };
  return { root, sourceRoot, dataRoot, source, output, inventory, options };
}

test('private export verifies all bytes and keeps original credentials out of the manifest', async () => {
  const f = await fixture(), m = await api();
  await writeFile(join(f.root, 'connection-keys.json'), '{"privateToken":"private-token-fixture"}');
  const manifest = await m.createTransferBundle({ ...f.options, privateFiles: [{ path: 'secrets/original-app.env', sourcePath: join(f.root, 'connection-keys.json') }] });
  assert.equal(manifest.kind, 'listingstudio-private-transfer');
  assert.equal(manifest.scope, 'selected-roots-only');
  assert.equal(manifest.files.length, 5);
  const text = await readFile(join(f.output, 'manifest.json'), 'utf8');
  for (const value of ['source-password', f.source.appEncryptionKey, 'private-token-fixture']) assert.equal(text.includes(value), false);
  const keyFile = JSON.parse(await readFile(join(f.output, 'secrets/app-key.json'), 'utf8'));
  assert.equal(keyFile.APP_ENCRYPTION_KEY, f.source.appEncryptionKey);
  const report = await m.verifyTransferBundle(f.output);
  assert.equal(report.verifiedFiles, 5);
  assert.equal(JSON.stringify(report).includes(f.source.appEncryptionKey), false);
  await assert.rejects(m.createTransferBundle(f.options), /OUTPUT_EXISTS/);
});

test('export requires quiescence and abandons a changed database snapshot without publishing a manifest', async () => {
  const f = await fixture(), m = await api();
  await assert.rejects(m.createTransferBundle({ ...f.options, quiesced: false }), /QUIESCENCE_REQUIRED/);
  assert.equal(await readFile(join(f.output, 'manifest.json')).catch(() => null), null);
  let reads = 0;
  await assert.rejects(m.createTransferBundle({ ...f.options, readDatabase: async () => {
    const result = structuredClone(f.inventory); if (++reads > 1) result.tables[1].sha256 = 'f'.repeat(64); return result;
  } }), /SOURCE_DATABASE_CHANGED/);
  assert.equal(await readFile(join(f.output, 'manifest.json')).catch(() => null), null);
});

test('verification rejects altered files, unsigned extras and traversal before reading secrets', async () => {
  const f = await fixture(), m = await api(); await m.createTransferBundle(f.options);
  await writeFile(join(f.output, 'data/source.png'), 'changed');
  await assert.rejects(m.verifyTransferBundle(f.output), /CHECKSUM_MISMATCH/);
  await writeFile(join(f.output, 'data/source.png'), 'immutable-original-image');
  await writeFile(join(f.output, 'unlisted.txt'), 'unlisted');
  await assert.rejects(m.verifyTransferBundle(f.output), /UNLISTED_FILE/);
  await rm(join(f.output, 'unlisted.txt'));
  const manifest = JSON.parse(await readFile(join(f.output, 'manifest.json'), 'utf8'));
  for (const path of ['../source/.local/data/source.png', 'data/../escape', 'C:/private/key.json', 'data/file.txt:secret', 'data\\escape']) {
    const bad = structuredClone(manifest); bad.files[0].path = path;
    await writeFile(join(f.output, 'manifest.json'), JSON.stringify(bad));
    await assert.rejects(m.verifyTransferBundle(f.output), /MANIFEST_PATH_INVALID/);
  }
});

test('export and verification refuse linked source directories and linked bundle files', async () => {
  const f = await fixture(), m = await api();
  const linked = join(f.root, 'linked-data'); await symlink(f.dataRoot, linked, 'junction');
  await assert.rejects(m.createTransferBundle({ ...f.options, sources: [{ label: 'data', path: linked }] }), /SYMLINK/);
  await m.createTransferBundle(f.options);
  await mkdir(join(f.root, 'outside')); await writeFile(join(f.root, 'outside/new.txt'), 'outside');
  await symlink(join(f.root, 'outside'), join(f.output, 'data/linked'), 'junction');
  await assert.rejects(m.verifyTransferBundle(f.output), /SYMLINK/);
});

function sealed(key, value, scope) {
  return import('node:crypto').then(({ createCipheriv }) => {
    const iv = Buffer.alloc(12, 7), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
    cipher.setAAD(Buffer.from(scope));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), bytes.toString('base64url')].join('.');
  });
}
async function databaseApi() {
  const module = await import('../scripts/transfer-database.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error;
  });
  assert.equal(typeof module.captureTransferDatabase, 'function', 'Consistent locked database export must exist');
  return module;
}
function snapshotClient(source, token, keyCipher) {
  const queries = [];
  return { queries, query: async sql => {
    queries.push(sql);
    if (/current_setting\('server_version_num'\)/.test(sql)) return { rows: [{ server_version: 170011, database: 'shopee_uploader', username: 'shopee', superuser: true }] };
    if (/FROM pg_tables/.test(sql)) return { rows: [{ name: 'connections' }, { name: 'schema_migrations' }] };
    if (/pg_export_snapshot/.test(sql)) return { rows: [{ snapshot: '000003-000004-1' }] };
    if (/to_jsonb\(t\)/.test(sql)) return { rows: [{ row_text: sql.includes('"connections"') ? '{"state":"connected","revision":4}' : '{"name":"001.sql"}' }] };
    if (/SELECT name,checksum FROM schema_migrations/.test(sql)) return { rows: [{ name: '001.sql', checksum: digest('fixture migration') }] };
    if (/relkind='S'/.test(sql)) return { rows: [] };
    if (/FROM connections/.test(sql)) return { rows: [{ id: 'connection-fixture', environment: 'production', partner_id: 'partner', shop_id: 'shop', revision: 4,
      partner_key_ciphertext: keyCipher, token_ciphertext: token }] };
    return { rows: [] };
  } };
}

test('database export locks tables and gives pg_dump the same exported snapshot as credential and inventory reads', async () => {
  const f = await fixture(), m = await databaseApi();
  const token = await sealed(f.source.appEncryptionKey, { accessToken: 'private-access', refreshToken: 'private-refresh', extra: 'preserved-field' }, 'production:partner:shop');
  const key = await sealed(f.source.appEncryptionKey, { partnerKey: 'private-partner' }, 'production:partner:shop');
  const client = snapshotClient(f.source, token, key);
  const dumpFile = join(f.root, 'snapshot.dump'); let dumped = false;
  const result = await m.captureTransferDatabase({ source: f.source, dumpFile, client, dump: async (path, context) => {
    assert.equal(context.snapshot, '000003-000004-1');
    assert.ok(context.args.includes('--schema=public'), 'The archive must match the public application inventory');
    assert.ok(client.queries.some(sql => /^LOCK TABLE .* IN SHARE MODE$/.test(sql)));
    assert.equal(client.queries.includes('COMMIT'), false);
    await writeFile(path, 'PGDMPfixture'); dumped = true;
  } });
  assert.equal(dumped, true); assert.equal(client.queries.at(-1), 'COMMIT');
  assert.equal(result.consistency, 'repeatable-read-exported-snapshot-share-locks');
  assert.equal(result.inventory.credentials.checkedCiphertexts, 2);
  assert.equal(result.connectionKeys.connections[0].token.extra, 'preserved-field');
  assert.equal(JSON.stringify(result.inventory).includes('private-access'), false);
  assert.equal(JSON.stringify(result.inventory).includes('private-partner'), false);
});

test('an encryption key mismatch aborts the source snapshot before pg_dump and releases locks', async () => {
  const f = await fixture(), m = await databaseApi();
  const wrong = await sealed('a'.repeat(64), { accessToken: 'wrong-key-private-token' }, 'production:partner:shop');
  const client = snapshotClient(f.source, wrong, null); let dumpCalls = 0;
  await assert.rejects(m.captureTransferDatabase({ source: f.source, dumpFile: join(f.root, 'bad.dump'), client,
    dump: async () => { dumpCalls++; } }), /SOURCE_KEY_MISMATCH/);
  assert.equal(dumpCalls, 0); assert.equal(client.queries.at(-1), 'ROLLBACK');
});

async function ownedFixture(f) {
  const core = await import('../scripts/onboarding-core.mjs');
  const targetRoot = join(f.root, 'target'); await mkdir(join(targetRoot, '.local/data'), { recursive: true });
  const identity = await core.rootIdentity(targetRoot), configId = 'e'.repeat(32);
  const ports = { apiPort: 4919, webPort: 5819, databasePort: 5559 };
  const config = core.makeConfiguration(ports, { ...identity, configId });
  await writeFile(join(targetRoot, '.env'), config.appText);
  await writeFile(join(targetRoot, '.local/docker.env'), config.dockerText);
  await mkdir(join(targetRoot, '.local/onboarding'));
  const receipt = { version: 1, kind: 'fresh-local-bootstrap', status: 'complete', configId, projectRoot: identity.projectRoot,
    rootHash: identity.rootHash, composeProject: identity.composeProject, volumeName: identity.volumeName, ports,
    phases: Object.fromEntries(['configuration', 'install', 'database', 'migrations', 'build'].map(name => [name, { state: 'complete' }])),
    sourceIdentity: { migrations: f.inventory.migrations },
    configuration: { appSha256: digest(config.appText), dockerSha256: digest(config.dockerText), keySha256: digest(config.env.APP_ENCRYPTION_KEY) } };
  await writeFile(join(targetRoot, '.local/onboarding/receipt.json'), JSON.stringify(receipt));
  return { targetRoot, identity, config, receipt, ports };
}
async function restoreApi() {
  const module = await import('../scripts/transfer-restore.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error;
  });
  assert.equal(typeof module.restoreTransferBundle, 'function', 'Audited fresh-target restore must exist');
  return module;
}
function targetAdapters(f, extra = {}) {
  let restored = false;
  const baseline = structuredClone(f.inventory);
  baseline.tables.forEach(table => { if (table.name !== 'schema_migrations') { table.rowCount = 0; table.sha256 = digest(''); } });
  baseline.tables[0].sha256 = digest('target migration timestamps');
  baseline.sequences[0] = { ...baseline.sequences[0], lastValue: '1', isCalled: false };
  return { portAvailable: async () => true, inspectRuntime: async () => ({ owned: true, running: false }),
    inspectContainer: async owned => ({ container: 'isolated-fixture-container', project: owned.identity.composeProject }),
    client: { query: async () => ({ rows: [] }) },
    readDatabase: async (_client, _key, owned) => ({ inventory: structuredClone(restored ? { ...f.inventory, tables: f.inventory.tables.map(table => table.name === 'schema_migrations' ? baseline.tables[0] : table) } : baseline),
      connectionKeys: { version: 1, connections: [] }, databaseIdentity: { database: 'shopee_uploader', username: 'shopee', server_version: 170011, superuser: true } }),
    restoreDatabase: async () => { restored = true; }, ...extra };
}

test('restore plan stays read-only and refuses a non-empty target or mismatched migration history', async () => {
  const f = await fixture(), m = await api(), r = await restoreApi(); await m.createTransferBundle(f.options);
  const t = await ownedFixture(f), before = await readFile(join(t.targetRoot, '.env'));
  const adapters = targetAdapters(f);
  const plan = await r.planTransferBundle(t.targetRoot, { bundle: f.output }, adapters);
  assert.equal(plan.ready, true); assert.equal(plan.workerAllowed, false);
  assert.deepEqual(await readFile(join(t.targetRoot, '.env')), before);
  assert.deepEqual(await readdir(join(t.targetRoot, '.local/data')), []);
  assert.equal(await readFile(join(t.targetRoot, '.local/onboarding/transfer-state.json')).catch(() => null), null);
  const original = adapters.readDatabase;
  adapters.readDatabase = async (...args) => { const result = await original(...args); result.inventory.tables[1].rowCount = 1; return result; };
  const busy = await r.planTransferBundle(t.targetRoot, { bundle: f.output }, adapters);
  assert.equal(busy.ready, false); assert.ok(busy.checks.some(check => check.code === 'TRANSFER_TARGET_DATABASE_NOT_EMPTY'));
  adapters.readDatabase = async (...args) => { const result = await original(...args); result.inventory.migrations[0].checksum = 'a'.repeat(64); return result; };
  const mismatch = await r.planTransferBundle(t.targetRoot, { bundle: f.output }, adapters);
  assert.equal(mismatch.ready, false); assert.ok(mismatch.checks.some(check => check.code === 'TRANSFER_MIGRATIONS_MISMATCH'));
});

test('fresh restore retains target credentials and ports, verifies source journals, adopts only the source key and leaves work held', async () => {
  const f = await fixture(), m = await api(), r = await restoreApi(); await m.createTransferBundle(f.options);
  const t = await ownedFixture(f), beforeDocker = await readFile(join(t.targetRoot, '.local/docker.env'));
  const adapters = targetAdapters(f); const restore = adapters.restoreDatabase;
  adapters.restoreDatabase = async context => {
    const state = JSON.parse(await readFile(join(t.targetRoot, '.local/onboarding/transfer-state.json')));
    const hold = JSON.parse(await readFile(join(t.targetRoot, '.local/onboarding/transfer-hold.json')));
    assert.equal(state.status, 'restore_sent'); assert.equal(hold.workerAllowed, false);
    assert.equal(context.owned.env.DATABASE_URL, t.config.env.DATABASE_URL);
    assert.deepEqual(await readFile(join(t.targetRoot, '.local/data/source.png'), 'utf8'), 'immutable-original-image');
    await restore(context);
  };
  const report = await r.restoreTransferBundle(t.targetRoot, { bundle: f.output, apply: true }, adapters);
  assert.equal(report.status, 'complete'); assert.equal(report.workerAllowed, false);
  const core = await import('../scripts/onboarding-core.mjs'), owned = await core.readOwnedConfiguration(t.targetRoot);
  assert.equal(owned.env.DATABASE_URL, t.config.env.DATABASE_URL);
  assert.equal(owned.env.APP_ENCRYPTION_KEY, f.source.appEncryptionKey);
  assert.deepEqual(owned.ports, t.ports); assert.equal(owned.env.PRODUCTION_PILOT_ENABLED, '0');
  assert.equal(owned.env.SHOPEE_PRODUCTION_WRITES, 'false'); assert.equal(owned.env.CONNECTION_MAINTENANCE_ENABLED, '0');
  assert.deepEqual(await readFile(join(t.targetRoot, '.local/docker.env')), beforeDocker);
  const state = JSON.parse(await readFile(join(t.targetRoot, '.local/onboarding/transfer-state.json')));
  assert.equal(state.status, 'complete'); assert.equal(state.databaseVerification.verified, true);
  assert.equal(state.adoptedKeySha256, digest(f.source.appEncryptionKey));
  assert.deepEqual(state.configurationAfter, owned.receipt.configuration);
  assert.ok(Object.values(state.phases).every(phase => phase.state === 'complete'));
  assert.equal(JSON.stringify(state).includes(f.source.appEncryptionKey), false);
  assert.equal(state.databaseVerification.sourceTablesVerified, 2);
  await assert.rejects(r.restoreTransferBundle(t.targetRoot, { bundle: f.output, apply: true }, adapters), /TRANSFER_REVIEW_REQUIRED/);
});

test('an unknown restore durably blocks retries and cannot expose partial data through a completed proof', async () => {
  const f = await fixture(), m = await api(), r = await restoreApi(); await m.createTransferBundle(f.options);
  const t = await ownedFixture(f); let attempts = 0;
  const adapters = targetAdapters(f, { restoreDatabase: async () => { attempts++; throw Error('sensitive database exception'); } });
  await assert.rejects(r.restoreTransferBundle(t.targetRoot, { bundle: f.output, apply: true }, adapters), /TRANSFER_RESTORE_UNKNOWN/);
  const state = JSON.parse(await readFile(join(t.targetRoot, '.local/onboarding/transfer-state.json')));
  assert.equal(state.status, 'restore_unknown'); assert.notEqual(state.phases.restoreDatabase.state, 'complete');
  assert.equal(JSON.stringify(state).includes('sensitive database exception'), false);
  assert.equal(JSON.parse(await readFile(join(t.targetRoot, '.local/onboarding/transfer-hold.json'))).workerAllowed, false);
  await assert.rejects(r.restoreTransferBundle(t.targetRoot, { bundle: f.output, apply: true }, adapters), /TRANSFER_REVIEW_REQUIRED/);
  assert.equal(attempts, 1);
  assert.equal((await (await import('../scripts/onboarding-core.mjs')).readOwnedConfiguration(t.targetRoot)).env.APP_ENCRYPTION_KEY, t.config.env.APP_ENCRYPTION_KEY);
});

test('data-only restore list excludes the migration ledger and rejects undeclared tables or duplicate data entries', async () => {
  const r = await restoreApi(), f = await fixture();
  const toc = '; Archive created at fixture\n1; 0 1 TABLE DATA public schema_migrations shopee\n2; 0 2 TABLE DATA public products shopee\n3; 0 3 TABLE DATA public jobs shopee\n4; 0 0 SEQUENCE SET public job_events_id_seq shopee\n5; 1 2 FUNCTION public irrelevant() shopee\n';
  const selected = r.filterRestoreList(toc, f.inventory);
  assert.equal(selected.includes('schema_migrations'), false); assert.equal(selected.includes('FUNCTION'), false);
  assert.equal(selected.includes('TABLE DATA public jobs'), true); assert.equal(selected.includes('SEQUENCE SET'), true);
  assert.throws(() => r.filterRestoreList(toc + '6; 0 4 TABLE DATA public undeclared shopee\n', f.inventory), /TRANSFER_DUMP_OBJECT_MISMATCH/);
  assert.throws(() => r.filterRestoreList(toc + '7; 0 2 TABLE DATA public products shopee\n', f.inventory), /TRANSFER_DUMP_OBJECT_MISMATCH/);
});

test('blob relocation is typed and audited without changing immutable history or source fingerprints', async () => {
  const r = await restoreApi(), f = await fixture();
  const hash = digest('immutable-original-image');
  const manifest = { bundleId: 'd'.repeat(32), roots: [{ label: 'data', originalPath: 'D:/old-data' }], files: [{ path: `data/blobs/${hash.slice(0, 2)}/${hash}`, bytes: 24, sha256: hash }],
    databaseInventory: { storagePaths: [{ sha256: hash, bytes: 24, path: `D:/old-data/blobs/${hash.slice(0, 2)}/${hash}` }] } };
  const changes = r.planBlobRelocations(join(f.root, 'target'), manifest);
  assert.equal(changes.length, 1); assert.equal(changes[0].sha256, hash);
  assert.equal(changes[0].to, join(f.root, 'target', '.local/data/blobs', hash.slice(0, 2), hash));
  const queries = [];
  await r.relocateBlobStorage({ query: async (sql, params) => { queries.push({ sql, params }); return { rowCount: 1, rows: [] }; } }, changes);
  assert.equal(queries.length, 1); assert.match(queries[0].sql, /^UPDATE shop_listing_media_blobs SET storage_path/);
  assert.match(queries[0].sql, /sha256.*storage_path.*byte_count/);
  assert.deepEqual(queries[0].params, [changes[0].to, hash, changes[0].from, 24]);
  const outside = structuredClone(manifest); outside.databaseInventory.storagePaths[0].path = 'D:/outside/blob';
  assert.throws(() => r.planBlobRelocations(join(f.root, 'target'), outside), /TRANSFER_BLOB_SOURCE_UNMAPPED/);
});

test('transfer CLI requires explicit private export consent and rejects alternate target roots or implicit mutations', async () => {
  const m = await api();
  assert.equal(typeof m.parseTransferArguments, 'function');
  assert.deepEqual(m.parseTransferArguments(['restore', '--bundle', 'bundle']), { action: 'restore', bundle: 'bundle', apply: false });
  assert.deepEqual(m.parseTransferArguments(['restore', '--bundle', 'bundle', '--apply']), { action: 'restore', bundle: 'bundle', apply: true });
  assert.throws(() => m.parseTransferArguments(['restore', '--bundle', 'bundle', '--root', 'other']), /TRANSFER_USAGE/);
  assert.throws(() => m.parseTransferArguments(['create', '--source-env', 'env', '--output', 'bundle', '--source-container', 'source']), /TRANSFER_QUIESCENCE_REQUIRED/);
  assert.throws(() => m.parseTransferArguments(['verify', '--bundle', 'bundle', '--apply']), /TRANSFER_USAGE/);
  assert.equal(m.parseTransferArguments(['create', '--source-env', 'env', '--output', 'bundle', '--source-container', 'source', '--quiesced', '--receipt-root', 'a', '--receipt-root', 'b']).receiptRoots.length, 2);
});

test('target Docker ownership and exact PostgreSQL17 image are checked before restore', async () => {
  const f = await fixture(), r = await restoreApi(), t = await ownedFixture(f);
  const owned = await (await import('../scripts/onboarding-core.mjs')).readOwnedConfiguration(t.targetRoot);
  const labels = { 'com.docker.compose.project': owned.identity.composeProject, 'com.docker.compose.volume': 'database',
    'com.docker.compose.service': 'postgres', 'com.shopee-uploader.onboarding.root': owned.identity.rootHash, 'com.shopee-uploader.onboarding.config': owned.receipt.configId };
  const container = { image: 'postgres:17.11-alpine', labels, ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5559' }] },
    mounts: [{ Type: 'volume', Name: owned.identity.volumeName, Destination: '/var/lib/postgresql/data' }], state: { Running: true, Health: { Status: 'healthy' } } };
  const run = async ({ args }) => {
    assert.equal(args.some(arg => arg.includes(owned.env.APP_ENCRYPTION_KEY)), false);
    if (args[0] === 'ps') return { exitCode: 0, stdout: 'abcdef123456\n' };
    if (args[0] === 'volume' && args[1] === 'ls') return { exitCode: 0, stdout: owned.identity.volumeName + '\n' };
    if (args[0] === 'volume') return { exitCode: 0, stdout: JSON.stringify(labels) };
    return { exitCode: 0, stdout: JSON.stringify(container) };
  };
  assert.equal((await r.inspectTargetContainer(owned, { run })).container, 'abcdef123456');
  container.image = 'postgres:16-alpine';
  await assert.rejects(r.inspectTargetContainer(owned, { run }), /TRANSFER_CONTAINER_IDENTITY_UNVERIFIED/);
  container.image = 'postgres:17.11-alpine'; labels['com.shopee-uploader.onboarding.config'] = 'f'.repeat(32);
  await assert.rejects(r.inspectTargetContainer(owned, { run }), /DOCKER_OWNERSHIP_MISMATCH/);
});

test('a successful database command with wrong journal bytes remains held and never adopts the encryption key', async () => {
  const f = await fixture(), m = await api(), r = await restoreApi(); await m.createTransferBundle(f.options);
  const t = await ownedFixture(f), adapters = targetAdapters(f); let sent = false;
  const original = adapters.readDatabase, restore = adapters.restoreDatabase;
  adapters.restoreDatabase = async context => { await restore(context); sent = true; };
  adapters.readDatabase = async (...args) => { const result = await original(...args); if (sent) result.inventory.tables[2].sha256 = digest('falsified journal'); return result; };
  await assert.rejects(r.restoreTransferBundle(t.targetRoot, { bundle: f.output, apply: true }, adapters), /TRANSFER_DATABASE_HASH_MISMATCH/);
  const state = JSON.parse(await readFile(join(t.targetRoot, '.local/onboarding/transfer-state.json')));
  assert.equal(state.status, 'failed'); assert.equal(state.phases.restoreDatabase.state, 'complete');
  assert.notEqual(state.phases.verifyDatabase.state, 'complete');
  assert.equal((await (await import('../scripts/onboarding-core.mjs')).readOwnedConfiguration(t.targetRoot)).env.APP_ENCRYPTION_KEY, t.config.env.APP_ENCRYPTION_KEY);
});

test('verification rejects a linked manifest before trying to parse any linked content', async () => {
  const f = await fixture(), m = await api(); await m.createTransferBundle(f.options);
  await rm(join(f.output, 'manifest.json'));
  await symlink(f.dataRoot, join(f.output, 'manifest.json'), 'junction');
  await assert.rejects(m.verifyTransferBundle(f.output), /TRANSFER_SYMLINK_FORBIDDEN/);
});

test('a dump changed after planning is rejected before any database restore command', async () => {
  const f = await fixture(), m = await api(), r = await restoreApi(); await m.createTransferBundle(f.options);
  const t = await ownedFixture(f), adapters = targetAdapters(f); let inspected = 0, restored = 0;
  const inspect = adapters.inspectContainer;
  adapters.inspectContainer = async (...args) => { const result = await inspect(...args); if (++inspected === 2) await writeFile(join(f.output, 'database.dump'), 'PGDMPchanged-after-check'); return result; };
  adapters.restoreDatabase = async () => { restored++; };
  await assert.rejects(r.restoreTransferBundle(t.targetRoot, { bundle: f.output, apply: true }, adapters), /TRANSFER_CHECKSUM_MISMATCH/);
  assert.equal(restored, 0);
  const state = JSON.parse(await readFile(join(t.targetRoot, '.local/onboarding/transfer-state.json')));
  assert.equal(state.status, 'failed'); assert.equal(state.phases.restoreDatabase.state, 'pending');
});

test('relocation verifies every blob field except its typed path and preserves historical database tables', async () => {
  const f = await fixture(), m = await api(), r = await restoreApi(), hash = digest('immutable-original-image');
  f.inventory.tables.push({ name: 'shop_listing_media_blobs', rowCount: 1, sha256: digest('blob-row-at-source-path'), withoutStoragePathSha256: digest('immutable-blob-metadata') });
  f.inventory.storagePaths = [{ sha256: hash, bytes: 24, path: join(f.dataRoot, 'source.png') }];
  await m.createTransferBundle(f.options); const t = await ownedFixture(f), adapters = targetAdapters(f); let relocated = false;
  const original = adapters.readDatabase;
  adapters.client.query = async sql => { if (sql.startsWith('UPDATE shop_listing_media_blobs')) relocated = true; return { rowCount: 1, rows: [] }; };
  adapters.readDatabase = async (...args) => {
    const result = await original(...args);
    if (!result.inventory.tables.find(table => table.name === 'shop_listing_media_blobs').rowCount) result.inventory.storagePaths = [];
    else if (relocated) {
      result.inventory.storagePaths[0].path = join(t.targetRoot, '.local/data/source.png');
      result.inventory.tables.find(table => table.name === 'shop_listing_media_blobs').sha256 = digest('blob-row-at-target-path');
    }
    return result;
  };
  const report = await r.restoreTransferBundle(t.targetRoot, { bundle: f.output, apply: true }, adapters);
  assert.equal(report.databaseVerification.relocatedBlobCount, 1);
  const audit = JSON.parse(await readFile(join(t.targetRoot, '.local/onboarding/transfer-relocation.json')));
  assert.equal(audit.historicalJsonUnchanged, true); assert.equal(audit.changes[0].from, f.inventory.storagePaths[0].path);
  assert.equal(audit.changes[0].to, join(t.targetRoot, '.local/data/source.png'));
});

test('full-database archives select declared public app data and omit unrelated schemas', async () => {
  const r = await restoreApi(), f = await fixture();
  const toc = '1; 0 1 TABLE DATA public schema_migrations shopee\n2; 0 2 TABLE DATA public products shopee\n3; 0 3 TABLE DATA public jobs shopee\n4; 0 0 SEQUENCE SET public job_events_id_seq shopee\n5; 0 5 TABLE DATA old_fixture products shopee\n6; 0 6 TABLE DATA training_history jobs shopee\n7; 0 0 SEQUENCE SET old_fixture job_events_id_seq shopee\n';
  const selected = r.filterRestoreList(toc, f.inventory);
  assert.equal(selected.includes('old_fixture'), false); assert.equal(selected.includes('training_history'), false);
  assert.equal(selected.includes('schema_migrations'), false);
  assert.equal(selected.trim().split('\n').length, 3);
  assert.throws(() => r.filterRestoreList(toc + '8; 0 7 TABLE DATA public unknown_history shopee\n', f.inventory), /TRANSFER_DUMP_OBJECT_MISMATCH/);
  assert.throws(() => r.filterRestoreList(toc.replace('2; 0 2 TABLE DATA public products shopee\n', ''), f.inventory), /TRANSFER_DUMP_OBJECT_MISMATCH/);
});

test('unknown restore records only safe adapter stage and codes, never raw error text', async () => {
  const f = await fixture(), m = await api(), r = await restoreApi(); await m.createTransferBundle(f.options);
  const t = await ownedFixture(f);
  const error = Object.assign(Error('private COPY row, token, connection secret'), { restoreDiagnostic: { stage: 'restore-data', code: 'TRANSFER_DATABASE_TOOL_FAILED',
    exitCode: 1, stderrBytes: 321, stderrSha256: digest('private error bytes'), stderrCode: 'POSTGRES_PERMISSION_DENIED', rawStderr: 'private-access-secret' } });
  const adapters = targetAdapters(f, { restoreDatabase: async () => { throw error; } });
  await assert.rejects(r.restoreTransferBundle(t.targetRoot, { bundle: f.output, apply: true }, adapters), /TRANSFER_RESTORE_UNKNOWN/);
  const state = JSON.parse(await readFile(join(t.targetRoot, '.local/onboarding/transfer-state.json')));
  assert.equal(state.restoreDiagnostic.stage, 'restore-data'); assert.equal(state.restoreDiagnostic.code, 'TRANSFER_DATABASE_TOOL_FAILED');
  assert.equal(state.restoreDiagnostic.exitCode, 1); assert.equal(state.restoreDiagnostic.stderrCode, 'POSTGRES_PERMISSION_DENIED');
  assert.equal(JSON.stringify(state).includes('private-access-secret'), false); assert.equal(JSON.stringify(state).includes('private COPY'), false);
});

test('Docker restore adapter uses only filtered public data in one transaction and exposes safe pre-restore stage failures', async () => {
  const f = await fixture(), r = await restoreApi(), t = await ownedFixture(f);
  const owned = await (await import('../scripts/onboarding-core.mjs')).readOwnedConfiguration(t.targetRoot);
  const bundle = { directory: f.output, manifest: { bundleId: 'd'.repeat(32) } }, container = { container: 'verified-target' };
  const toc = '1; 0 1 TABLE DATA public schema_migrations shopee\n2; 0 2 TABLE DATA public products shopee\n3; 0 3 TABLE DATA public jobs shopee\n4; 0 0 SEQUENCE SET public job_events_id_seq shopee\n5; 0 5 TABLE DATA unrelated_fixture products shopee\n';
  const commands = [], stream = async (args, context) => { commands.push({args,context}); return args.includes('--list') ? toc : ''; };
  await r.restoreDatabaseDocker({ owned, container, bundle, inventory: f.inventory }, { inspectContainer: async () => container, stream });
  assert.equal(commands.length, 4);
  const restore = commands.find(command => command.args.includes('--data-only'));
  assert.ok(restore); for (const flag of ['--disable-triggers','--single-transaction','--exit-on-error','--no-owner','--no-privileges']) assert.ok(restore.args.includes(flag));
  assert.equal(restore.args.includes('--clean'), false); assert.equal(restore.args.includes('--create'), false);
  const list = commands.find(command => command.args.includes('tee')).context.inputBytes.toString('utf8');
  assert.equal(list.includes('unrelated_fixture'), false); assert.equal(list.includes('schema_migrations'), false);
  const failingCommands = [];
  await assert.rejects(r.restoreDatabaseDocker({ owned, container, bundle, inventory: f.inventory }, { inspectContainer: async () => container,
    stream: async args => { failingCommands.push(args); return toc + '6; 0 6 TABLE DATA public undeclared shopee\n'; } }), error => {
      assert.equal(error.restoreDiagnostic.stage, 'select-public-data'); assert.equal(error.restoreDiagnostic.code, 'TRANSFER_DUMP_OBJECT_MISMATCH'); return true;
    });
  assert.equal(failingCommands.length, 1);
});
