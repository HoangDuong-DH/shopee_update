import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { noLinks, exists, within, bundlePath, inventoryFiles, recordFile, copyVerified, writeExclusive, sha256 } from './transfer-files.mjs';
import { isMain, safeError } from './onboarding-core.mjs';

const CORPORA = ['shopee-open-platform', 'shopee-uni-vn'];
const GUIDES = ['README.md', 'AGENT_GUIDE.md', 'INDEX.md', 'COVERAGE.md', 'DOCUMENTATION.md', 'LATEST_NEWS.md'];
const SELLER = 'shopee-seller-observations';
const MAX_GUIDE_BYTES = 256 * 1024;
const MAX_SELLER_BYTES = 2 * 1024 * 1024;
const KIND = 'listingstudio-private-reference-library';

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw Error('REFERENCE_MANIFEST_INVALID'); }
}
async function selectFiles(knowledgeRoot) {
  knowledgeRoot = resolve(knowledgeRoot); await noLinks(knowledgeRoot);
  const files = new Map(), entryCounts = {};
  const add = async (name, expected) => {
    bundlePath(name);
    const row = await recordFile(knowledgeRoot, name);
    if (expected && row.sha256 !== expected.toLowerCase()) throw Error('REFERENCE_ENTRY_CHECKSUM_MISMATCH');
    const prior = files.get(name.toLowerCase());
    if (prior && (prior.path !== name || prior.sha256 !== row.sha256)) throw Error('REFERENCE_DUPLICATE_PATH');
    files.set(name.toLowerCase(), row);
    return row;
  };
  const guides = async prefix => {
    for (const name of GUIDES) {
      const path = prefix + name;
      if (await exists(resolve(knowledgeRoot, path))) {
        const row = await add(path);
        if (row.bytes > MAX_GUIDE_BYTES) throw Error('REFERENCE_GUIDE_TOO_LARGE');
      }
    }
  };
  const entries = async (prefix, rows, corpus) => {
    if (!Array.isArray(rows) || !rows.length) throw Error('REFERENCE_CORPUS_MANIFEST_INVALID');
    for (const entry of rows) {
      const path = bundlePath(entry?.path);
      const hash = corpus === 'shopee-open-platform'
        ? entry.markdown_sha256 ?? entry.sha256 : entry.sha256 ?? entry.markdown_sha256;
      if (!/^[a-f0-9]{64}$/i.test(hash ?? '')) throw Error('REFERENCE_ENTRY_HASH_REQUIRED');
      await add(prefix + path, hash);
    }
    entryCounts[corpus] = rows.length;
  };
  await guides('');
  for (const corpus of CORPORA) {
    const prefix = corpus + '/';
    await add(prefix + 'manifest.json'); await add(prefix + 'search.sqlite');
    await entries(prefix, await readJson(resolve(knowledgeRoot, prefix + 'manifest.json')), corpus);
    await guides(prefix);
  }
  let sellerObservationFiles = 0, sellerObservationsOmittedForSize = false;
  if (await exists(resolve(knowledgeRoot, SELLER))) {
    const names = await inventoryFiles(resolve(knowledgeRoot, SELLER)), sellerRows = [];
    for (const name of names) sellerRows.push(await recordFile(knowledgeRoot, SELLER + '/' + name));
    if (sellerRows.reduce((sum, row) => sum + row.bytes, 0) <= MAX_SELLER_BYTES) {
      for (const row of sellerRows) files.set(row.path.toLowerCase(), row);
      const manifest = await readJson(resolve(knowledgeRoot, SELLER, 'manifest.json'));
      await entries(SELLER + '/', manifest.documents, SELLER);
      sellerObservationFiles = sellerRows.length;
    } else sellerObservationsOmittedForSize = true;
  }
  return { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')),
    entryCounts, sellerObservationFiles, sellerObservationsOmittedForSize };
}
function counts(manifest, manifestSha256) {
  return { verifiedFiles: manifest.files.length, bytes: manifest.files.reduce((sum, row) => sum + row.bytes, 0),
    corpora: CORPORA.length, sellerObservationFiles: manifest.sellerObservationFiles, manifestSha256 };
}
async function loadLibrary(directory) {
  directory = resolve(directory); await noLinks(directory); await noLinks(resolve(directory, 'manifest.json'));
  const text = await readFile(resolve(directory, 'manifest.json'), 'utf8').catch(() => { throw Error('REFERENCE_MANIFEST_REQUIRED'); });
  let manifest; try { manifest = JSON.parse(text); } catch { throw Error('REFERENCE_MANIFEST_INVALID'); }
  if (manifest?.version !== 1 || manifest.kind !== KIND || manifest.scope !== 'retrieval-text-and-indexes'
    || JSON.stringify(manifest.corpora) !== JSON.stringify(CORPORA) || !Array.isArray(manifest.files) || !manifest.files.length
    || !Number.isSafeInteger(manifest.sellerObservationFiles) || manifest.sellerObservationFiles < 0)
    throw Error('REFERENCE_MANIFEST_INVALID');
  const seen = new Set();
  for (const row of manifest.files) {
    const name = bundlePath(row?.path), key = name.toLowerCase();
    if (!name.startsWith('knowledge-base/') || seen.has(key) || !/^[a-f0-9]{64}$/.test(row.sha256 ?? '')
      || !Number.isSafeInteger(row.bytes) || row.bytes < 0) throw Error('REFERENCE_MANIFEST_PATH_INVALID');
    seen.add(key);
  }
  const actual = await inventoryFiles(directory);
  if (actual.length !== manifest.files.length + 1 || actual.some(name => name !== 'manifest.json' && !seen.has(name.toLowerCase())))
    throw Error('REFERENCE_UNLISTED_FILE');
  for (const row of manifest.files) {
    const found = await recordFile(directory, row.path);
    if (found.bytes !== row.bytes || found.sha256 !== row.sha256) throw Error('REFERENCE_CHECKSUM_MISMATCH');
  }
  // Independently re-read the original corpus manifests. Replacing outer bundle
  // hashes cannot bless text that differs from those manifest entry hashes.
  const selected = await selectFiles(resolve(directory, 'knowledge-base'));
  const expected = selected.files.map(row => ({ ...row, path: 'knowledge-base/' + row.path }));
  if (JSON.stringify(expected) !== JSON.stringify(manifest.files)
    || selected.sellerObservationFiles !== manifest.sellerObservationFiles
    || JSON.stringify(selected.entryCounts) !== JSON.stringify(manifest.entryCounts))
    throw Error('REFERENCE_CLOSURE_MISMATCH');
  if (sha256(await readFile(resolve(directory, 'manifest.json'))) !== sha256(text)) throw Error('REFERENCE_SOURCE_CHANGED');
  return { directory, manifest, manifestSha256: sha256(text) };
}
export async function createReferenceLibrary({ projectRoot, output }) {
  const knowledgeRoot = resolve(projectRoot, 'knowledge-base'); output = resolve(output);
  await noLinks(output);
  if (output === knowledgeRoot || within(knowledgeRoot, output) || within(output, knowledgeRoot)) throw Error('REFERENCE_OUTPUT_OVERLAPS_SOURCE');
  if (await exists(output)) throw Error('REFERENCE_OUTPUT_EXISTS');
  const selected = await selectFiles(knowledgeRoot);
  await mkdir(dirname(output), { recursive: true }); await noLinks(dirname(output)); await mkdir(output);
  const files = selected.files.map(row => ({ ...row, path: 'knowledge-base/' + row.path }));
  for (const row of selected.files) await copyVerified(resolve(knowledgeRoot, row.path), resolve(output, 'knowledge-base', row.path), row);
  const manifest = { version: 1, kind: KIND, createdAt: new Date().toISOString(), scope: 'retrieval-text-and-indexes',
    corpora: CORPORA, entryCounts: selected.entryCounts, sellerObservationFiles: selected.sellerObservationFiles,
    sellerObservationsOmittedForSize: selected.sellerObservationsOmittedForSize,
    privateSellerObservationsRequiredByApi: false, sellerObservationScope: 'entire-folder-only-when-at-most-2-MiB',
    excludedRuntimeCorpusFiles: ['undeclared raw', 'assets', 'downloads', 'work directories'], files };
  await writeExclusive(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return verifyReferenceLibrary(output);
}
export async function verifyReferenceLibrary(library) {
  const { manifest, manifestSha256 } = await loadLibrary(library);
  return counts(manifest, manifestSha256);
}
export async function importReferenceLibrary({ projectRoot, library, apply = false }) {
  const loaded = await loadLibrary(library), report = counts(loaded.manifest, loaded.manifestSha256);
  const root = resolve(projectRoot), target = resolve(root, 'knowledge-base'), receiptPath = resolve(root, '.local/reference-library/import-receipt.json');
  await noLinks(root); await noLinks(target); await noLinks(receiptPath);
  if (!(await lstat(root)).isDirectory()) throw Error('REFERENCE_TARGET_INVALID');
  if (target === loaded.directory || within(target, loaded.directory) || within(loaded.directory, target))
    throw Error('REFERENCE_TARGET_OVERLAPS_LIBRARY');
  if (!apply) return { ...report, plannedFiles: report.verifiedFiles, importedFiles: 0 };
  if (await exists(target)) throw Error('REFERENCE_TARGET_EXISTS');
  if (await exists(receiptPath)) throw Error('REFERENCE_RECEIPT_EXISTS');
  await mkdir(target); // Exclusive reservation; never merge into an existing library.
  const receipt = { version: 1, status: 'incomplete', manifestSha256: loaded.manifestSha256,
    scope: loaded.manifest.scope, ...report, importedFiles: 0 };
  const receiptText = JSON.stringify(receipt, null, 2) + '\n';
  await writeExclusive(receiptPath, receiptText);
  for (const row of loaded.manifest.files) {
    const destination = resolve(root, row.path);
    if (!within(target, destination)) throw Error('REFERENCE_MANIFEST_PATH_INVALID');
    await copyVerified(resolve(loaded.directory, row.path), destination, row);
  }
  const actual = await inventoryFiles(target);
  if (actual.length !== loaded.manifest.files.length) throw Error('REFERENCE_IMPORT_CHANGED');
  if (sha256(await readFile(resolve(loaded.directory, 'manifest.json'))) !== loaded.manifestSha256) throw Error('REFERENCE_SOURCE_CHANGED');
  await noLinks(receiptPath);
  if (await readFile(receiptPath, 'utf8') !== receiptText) throw Error('REFERENCE_RECEIPT_CHANGED');
  await writeFile(receiptPath, JSON.stringify({ ...receipt, status: 'complete', importedFiles: report.verifiedFiles,
    completedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  return { ...report, importedFiles: report.verifiedFiles };
}

const help = 'Usage: node scripts/reference-library.mjs export --output PATH\n'
  + '       node scripts/reference-library.mjs verify --library PATH\n'
  + '       node scripts/reference-library.mjs import --library PATH [--apply]\n'
  + 'Import without --apply only verifies and plans. Apply requires absent knowledge-base.\n'
  + 'The checkout containing this script is the source/import destination; no root override.\n'
  + 'Private library: text/index retrieval closure, optional modest seller observations.\n'
  + 'No database, environment, services, Shopee requests or existing-library overwrite.';
async function main(args) {
  if (args.length === 1 && args[0] === '--help') { console.log(help); return; }
  const [action, ...rest] = args, options = {};
  if (!['export', 'verify', 'import'].includes(action)) throw Error('REFERENCE_ARGUMENTS_INVALID');
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === '--apply' && action === 'import' && options.apply === undefined) options.apply = true;
    else if ((flag === '--output' && action === 'export' || flag === '--library' && action !== 'export')
      && options[flag.slice(2)] === undefined && rest[index + 1] && !rest[index + 1].startsWith('--'))
      options[flag.slice(2)] = rest[++index];
    else throw Error('REFERENCE_ARGUMENTS_INVALID');
  }
  if (!(action === 'export' ? options.output : options.library)) throw Error('REFERENCE_ARGUMENTS_INVALID');
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const report = action === 'export' ? await createReferenceLibrary({ projectRoot, output: options.output })
    : action === 'verify' ? await verifyReferenceLibrary(options.library)
      : await importReferenceLibrary({ projectRoot, ...options });
  console.log(JSON.stringify(report, null, 2));
}
if (isMain(import.meta.url)) main(process.argv.slice(2)).catch(error => {
  console.error(safeError(error, 'REFERENCE_OPERATION_FAILED')); process.exitCode = 1;
});
