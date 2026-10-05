import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { noLinks, exists, within, bundlePath, fileHash, inventoryFiles, recordFile, copyVerified,
  writeExclusive, loadVerifiedBundle, validateDatabaseInventory, sha256 } from './transfer-files.mjs';
import { isMain, safeError } from './onboarding-core.mjs';

export async function verifyTransferBundle(directory) {
  const { manifest, manifestSha256 } = await loadVerifiedBundle(directory);
  return { version: 1, verifiedFiles: manifest.files.length, bundleId: manifest.bundleId, manifestSha256,
    scope: manifest.scope, privateKeysIncluded: true, applicationStarted: false };
}

export async function createTransferBundle(options) {
  const { source, quiesced, privateFiles = [] } = options;
  if (quiesced !== true) throw Error('TRANSFER_QUIESCENCE_REQUIRED');
  if (!source || !/^[a-f0-9]{64}$/.test(source.appEncryptionKey ?? '')) throw Error('TRANSFER_SOURCE_KEY_REQUIRED');
  const output = resolve(options.output); await noLinks(output);
  if (await exists(output)) throw Error('TRANSFER_OUTPUT_EXISTS');
  const sources = options.sources ?? [{ label: 'data', path: source.dataRoot }];
  const seen = new Set(), inventories = [];
  for (const selected of sources) {
    if (!/^(data|receipts-[1-9][0-9]*)$/.test(selected.label) || seen.has(selected.label)) throw Error('TRANSFER_ROOT_LABEL_INVALID');
    seen.add(selected.label); const path = resolve(selected.path); await noLinks(path);
    if (path === output || within(path, output) || within(output, path)) throw Error('TRANSFER_OUTPUT_OVERLAPS_SOURCE');
    inventories.push({ label: selected.label, path, files: await inventoryFiles(path) });
  }
  if (!seen.has('data') || resolve(sources.find(entry => entry.label === 'data').path) !== resolve(source.dataRoot))
    throw Error('TRANSFER_DATA_ROOT_REQUIRED');
  for (const extra of privateFiles) {
    const path = bundlePath(extra.path);
    if (!/^secrets\/[^/]+$/.test(path) || ['secrets/app-key.json', 'secrets/connection-keys.json'].includes(path)) throw Error('TRANSFER_PRIVATE_PATH_RESERVED');
  }
  await mkdir(dirname(output), { recursive: true }); await mkdir(output);
  const dumpFile = resolve(output, 'database.dump');
  let capture;
  if (options.readDatabase) {
    const inventory = validateDatabaseInventory(await options.readDatabase(source));
    await options.dump(dumpFile, { source });
    const after = validateDatabaseInventory(await options.readDatabase(source));
    if (sha256(JSON.stringify(inventory)) !== sha256(JSON.stringify(after))) throw Error('TRANSFER_SOURCE_DATABASE_CHANGED');
    capture = { inventory, connectionKeys: { version: 1, connections: [] }, consistency: 'caller-quiesced-double-inventory' };
  } else {
    const { captureTransferDatabase } = await import('./transfer-database.mjs');
    capture = await captureTransferDatabase({ source, dumpFile, dump: options.dump, pgDump: options.pgDump, sourceContainer: options.sourceContainer });
  }
  const databaseInventory = validateDatabaseInventory(capture.inventory);
  await writeExclusive(resolve(output, 'secrets/app-key.json'), `${JSON.stringify({ version: 1, APP_ENCRYPTION_KEY: source.appEncryptionKey })}\n`);
  await writeExclusive(resolve(output, 'secrets/connection-keys.json'), `${JSON.stringify(capture.connectionKeys)}\n`);
  for (const selected of inventories) {
    for (const name of selected.files) await copyVerified(resolve(selected.path, name), resolve(output, selected.label, bundlePath(name)));
    if (JSON.stringify(selected.files) !== JSON.stringify(await inventoryFiles(selected.path))) throw Error('TRANSFER_SOURCE_FILES_CHANGED');
  }
  for (const extra of privateFiles) {
    const target = resolve(output, extra.path);
    if (extra.sourcePath) await copyVerified(resolve(extra.sourcePath), target);
    else if (Buffer.isBuffer(extra.bytes) || typeof extra.bytes === 'string') await writeExclusive(target, extra.bytes);
    else throw Error('TRANSFER_PRIVATE_FILE_INVALID');
  }
  const manifest = { version: 1, kind: 'listingstudio-private-transfer', bundleId: randomBytes(16).toString('hex'),
    createdAt: new Date().toISOString(), quiesced: true, consistency: capture.consistency, scope: 'selected-roots-only',
    source: { projectRoot: resolve(source.projectRoot), dataRoot: resolve(source.dataRoot), database: source.database,
      migrations: databaseInventory.migrations }, databaseInventory,
    roots: inventories.map(entry => ({ label: entry.label, originalPath: entry.path })), files: [] };
  for (const name of await inventoryFiles(output)) manifest.files.push(await recordFile(output, name));
  await writeExclusive(resolve(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await verifyTransferBundle(output);
  return manifest;
}

export { planTransferBundle, restoreTransferBundle } from './transfer-restore.mjs';
export { sourceDatabase } from './transfer-database.mjs';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function readTransferSource(sourceEnv, root = projectRoot) {
  const path = resolve(root, sourceEnv); await noLinks(path);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 256 * 1024) throw Error('TRANSFER_SOURCE_ENV_INVALID');
  const { createRequire } = await import('node:module');
  const { parse } = createRequire(resolve(projectRoot, 'package.json'))('dotenv');
  const env = parse(await readFile(path, 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(env.APP_ENCRYPTION_KEY ?? '') || !env.DATA_ROOT || !env.DATABASE_URL) throw Error('TRANSFER_SOURCE_ENV_INVALID');
  const { sourceDatabase } = await import('./transfer-database.mjs');
  return { projectRoot: resolve(root), dataRoot: resolve(root, env.DATA_ROOT), connectionString: env.DATABASE_URL,
    database: sourceDatabase(env.DATABASE_URL), appEncryptionKey: env.APP_ENCRYPTION_KEY };
}
export function parseTransferArguments(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { action: 'help' };
  const action = args[0] && !args[0].startsWith('-') ? args[0] : 'plan', values = action === args[0] ? args.slice(1) : args;
  if (!['create', 'verify', 'plan', 'restore'].includes(action)) throw Error('TRANSFER_USAGE');
  const options = { action, apply: false }, seen = new Set();
  if (action === 'create') options.receiptRoots = [];
  const names = { '--bundle': 'bundle', '--source-env': 'sourceEnv', '--output': 'output', '--pg-dump': 'pgDump', '--source-container': 'sourceContainer' };
  for (let index = 0; index < values.length; index++) {
    const flag = values[index];
    if (flag === '--receipt-root' && action === 'create') {
      const value = values[++index]; if (!value || value.startsWith('--')) throw Error('TRANSFER_USAGE'); options.receiptRoots.push(value); continue;
    }
    if (seen.has(flag)) throw Error('TRANSFER_USAGE'); seen.add(flag);
    if (flag === '--apply' && action === 'restore') { options.apply = true; continue; }
    if (flag === '--quiesced' && action === 'create') { options.quiesced = true; continue; }
    const name = names[flag];
    if (!name || (action === 'create' ? name === 'bundle' : name !== 'bundle')) throw Error('TRANSFER_USAGE');
    const value = values[++index]; if (!value || value.startsWith('--')) throw Error('TRANSFER_USAGE'); options[name] = value;
  }
  if (action === 'create') {
    if (!options.sourceEnv || !options.output || (options.sourceContainer && options.pgDump)) throw Error('TRANSFER_USAGE');
    if (options.quiesced !== true) throw Error('TRANSFER_QUIESCENCE_REQUIRED');
  } else if (!options.bundle) throw Error('TRANSFER_USAGE');
  return options;
}
export async function runTransferCli(args = process.argv.slice(2)) {
  const options = parseTransferArguments(args);
  if (options.action === 'help') return { version: 1, usage: ['create --source-env PATH --output DIR --quiesced [--source-container NAME | --pg-dump PATH] [--receipt-root PATH ...]',
    'verify --bundle DIR', 'plan --bundle DIR', 'restore --bundle DIR [--apply]'], workerAllowed: false };
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 20) throw Error('TRANSFER_NODE_24_REQUIRED');
  if (options.action === 'create') {
    const source = await readTransferSource(options.sourceEnv);
    const sources = [{ label: 'data', path: source.dataRoot }, ...options.receiptRoots.map((path, index) => ({ label: `receipts-${index + 1}`, path: resolve(projectRoot, path) }))];
    const manifest = await createTransferBundle({ ...options, output: resolve(projectRoot, options.output), source, sources,
      privateFiles: [{ path: 'secrets/original-app.env', sourcePath: resolve(projectRoot, options.sourceEnv) }] });
    return { version: 1, status: 'complete', bundleId: manifest.bundleId, verifiedFiles: manifest.files.length, scope: manifest.scope,
      privateKeysIncluded: true, applicationStarted: false, consistency: manifest.consistency };
  }
  if (options.action === 'verify') return verifyTransferBundle(resolve(projectRoot, options.bundle));
  const { planTransferBundle, restoreTransferBundle } = await import('./transfer-restore.mjs');
  const config = { bundle: resolve(projectRoot, options.bundle), apply: options.apply };
  return options.action === 'restore' ? restoreTransferBundle(projectRoot, config) : planTransferBundle(projectRoot, config);
}
if (isMain(import.meta.url)) {
  try {
    const result = await runTransferCli(); console.log(JSON.stringify(result, null, 2));
    if (result.ready === false) process.exitCode = 1;
  } catch (error) {
    const code = safeError(error, 'TRANSFER_FAILED');
    const { transferNextAction } = await import('./transfer-restore.mjs');
    console.error(JSON.stringify({ version: 1, status: 'blocked', code, action: transferNextAction(code) }, null, 2)); process.exitCode = 1;
  }
}
