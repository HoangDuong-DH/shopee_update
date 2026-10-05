import { lstat, readdir, readFile, mkdir, writeFile, copyFile, constants, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative, isAbsolute, sep, win32, posix } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const within = (parent, child) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
export async function exists(path) {
  return lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw Error('TRANSFER_PATH_UNREADABLE'); });
}
export async function noLinks(path) {
  let current = resolve(path);
  for (;;) {
    const stat = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw Error('TRANSFER_PATH_UNREADABLE'); });
    if (stat?.isSymbolicLink()) throw Error('TRANSFER_SYMLINK_FORBIDDEN');
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}
export function bundlePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.startsWith('/') || /[<>:"|?*\u0000-\u001f]/.test(name))
    throw Error('TRANSFER_MANIFEST_PATH_INVALID');
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw Error('TRANSFER_MANIFEST_PATH_INVALID');
  return name;
}
export async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function inventoryFiles(directory) {
  await noLinks(directory);
  const result = [];
  const collect = async path => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = resolve(path, entry.name);
      if (entry.isSymbolicLink()) throw Error('TRANSFER_SYMLINK_FORBIDDEN');
      if (entry.isDirectory()) await collect(target);
      else if (entry.isFile()) result.push(relative(directory, target).replaceAll('\\', '/'));
      else throw Error('TRANSFER_FILE_TYPE_INVALID');
    }
  };
  await collect(resolve(directory));
  return result.sort();
}
export async function recordFile(directory, name) {
  bundlePath(name); const file = resolve(directory, name); await noLinks(file);
  const stat = await lstat(file);
  if (!stat.isFile()) throw Error('TRANSFER_FILE_TYPE_INVALID');
  return { path: name, bytes: stat.size, sha256: await fileHash(file) };
}
export async function copyVerified(source, target, expected) {
  await noLinks(source); await noLinks(target);
  const before = await lstat(source), beforeHash = await fileHash(source);
  if (!before.isFile() || (expected && (before.size !== expected.bytes || beforeHash !== expected.sha256))) throw Error('TRANSFER_CHECKSUM_MISMATCH');
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target, constants.COPYFILE_EXCL);
  const after = await lstat(source);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || beforeHash !== await fileHash(source)
    || beforeHash !== await fileHash(target)) throw Error('TRANSFER_SOURCE_FILES_CHANGED');
}
export async function writeExclusive(path, bytes) {
  await noLinks(path); await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
}
export function validateDatabaseInventory(inventory) {
  if (inventory?.version !== 1 || inventory.postgresMajor !== 17 || !Array.isArray(inventory.tables)
    || !Array.isArray(inventory.sequences) || !Array.isArray(inventory.migrations) || !inventory.migrations.length
    || !Array.isArray(inventory.storagePaths) || inventory.credentials?.keyMatches !== true) throw Error('TRANSFER_DATABASE_INVENTORY_INVALID');
  const seen = new Set();
  for (const table of inventory.tables) {
    if (!/^[a-z][a-z0-9_]*$/.test(table.name ?? '') || seen.has(table.name) || !Number.isSafeInteger(table.rowCount)
      || table.rowCount < 0 || !/^[a-f0-9]{64}$/.test(table.sha256 ?? '')) throw Error('TRANSFER_DATABASE_INVENTORY_INVALID');
    seen.add(table.name);
  }
  if (!seen.has('schema_migrations')) throw Error('TRANSFER_DATABASE_INVENTORY_INVALID');
  const migrations = new Set();
  for (const row of inventory.migrations) {
    if (!/^[a-zA-Z0-9_.-]+\.sql$/.test(row.name ?? '') || migrations.has(row.name) || !/^[a-f0-9]{64}$/.test(row.checksum ?? ''))
      throw Error('TRANSFER_DATABASE_INVENTORY_INVALID');
    migrations.add(row.name);
  }
  const sequences = new Set();
  for (const sequence of inventory.sequences) {
    if (!/^[a-z][a-z0-9_]*$/.test(sequence.name ?? '') || sequences.has(sequence.name) || !/^-?\d+$/.test(sequence.lastValue ?? '')
      || typeof sequence.isCalled !== 'boolean') throw Error('TRANSFER_DATABASE_INVENTORY_INVALID');
    sequences.add(sequence.name);
  }
  const storage = new Set();
  for (const row of inventory.storagePaths) {
    if (!/^[a-f0-9]{64}$/.test(row.sha256 ?? '') || storage.has(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 1
      || typeof row.path !== 'string' || !row.path) throw Error('TRANSFER_DATABASE_INVENTORY_INVALID');
    storage.add(row.sha256);
  }
  return inventory;
}
export async function loadVerifiedBundle(directory) {
  directory = resolve(directory); await noLinks(directory); await noLinks(resolve(directory, 'manifest.json'));
  const text = await readFile(resolve(directory, 'manifest.json'), 'utf8').catch(() => { throw Error('TRANSFER_MANIFEST_REQUIRED'); });
  let manifest; try { manifest = JSON.parse(text); } catch { throw Error('TRANSFER_MANIFEST_INVALID'); }
  if (manifest.version !== 1 || manifest.kind !== 'listingstudio-private-transfer' || !/^[a-f0-9]{32}$/.test(manifest.bundleId ?? '')
    || manifest.quiesced !== true || manifest.scope !== 'selected-roots-only' || !Array.isArray(manifest.files)
    || !Array.isArray(manifest.roots) || !manifest.files.length || !manifest.source?.dataRoot || !manifest.source?.projectRoot)
    throw Error('TRANSFER_MANIFEST_INVALID');
  validateDatabaseInventory(manifest.databaseInventory);
  const labels = new Set();
  for (const root of manifest.roots) {
    if (!/^(data|receipts-[1-9][0-9]*)$/.test(root.label ?? '') || labels.has(root.label) || typeof root.originalPath !== 'string'
      || !root.originalPath) throw Error('TRANSFER_MANIFEST_INVALID');
    labels.add(root.label);
  }
  if (!labels.has('data')) throw Error('TRANSFER_MANIFEST_INVALID');
  const seen = new Set();
  for (const entry of manifest.files) {
    const name = bundlePath(entry.path), key = name.toLowerCase();
    if (seen.has(key) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)
      throw Error('TRANSFER_MANIFEST_INVALID');
    seen.add(key);
    const prefix = name.split('/')[0];
    if (name !== 'database.dump' && !(labels.has(prefix) && name.includes('/')) && !(prefix === 'secrets' && name.split('/').length === 2))
      throw Error('TRANSFER_MANIFEST_PATH_INVALID');
  }
  if (!seen.has('database.dump') || !seen.has('secrets/app-key.json') || !seen.has('secrets/connection-keys.json')) throw Error('TRANSFER_PRIVATE_COMPONENT_REQUIRED');
  const actual = await inventoryFiles(directory);
  if (actual.some(name => name !== 'manifest.json' && !seen.has(name.toLowerCase())) || actual.length !== manifest.files.length + 1)
    throw Error('TRANSFER_UNLISTED_FILE');
  for (const entry of manifest.files) {
    const actualFile = await recordFile(directory, entry.path);
    if (entry.bytes !== actualFile.bytes || entry.sha256 !== actualFile.sha256) throw Error('TRANSFER_CHECKSUM_MISMATCH');
  }
  const handle = await open(resolve(directory, 'database.dump'), 'r'), dump = Buffer.alloc(5);
  try { await handle.read(dump, 0, 5, 0); } finally { await handle.close(); }
  if (dump.toString('ascii') !== 'PGDMP') throw Error('TRANSFER_DUMP_FORMAT_INVALID');
  return { directory, manifest, manifestSha256: sha256(text) };
}
export function sourceRelative(root, file) {
  const flavor = /^[a-z]:[\\/]|^\\\\/i.test(root) ? win32 : posix;
  if (!flavor.isAbsolute(root) || !flavor.isAbsolute(file)) return null;
  const rel = flavor.relative(root, file);
  if (!rel || rel === '..' || rel.startsWith(`..${flavor.sep}`) || flavor.isAbsolute(rel)) return null;
  try { return bundlePath(rel.replaceAll('\\', '/')); } catch { return null; }
}
