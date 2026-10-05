import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const roots = [];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
after(async () => {
  for (const root of roots) {
    if (dirname(root) !== resolve(tmpdir()) || !root.includes('listingstudio-reference-test-')) throw Error('UNSAFE_TEST_CLEANUP');
    await rm(root, { recursive: true, force: true });
  }
});
async function api() {
  const module = await import('../scripts/reference-library.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof module.createReferenceLibrary, 'function', 'Reference library export must exist');
  return module;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'listingstudio-reference-test-')); roots.push(root);
  const projectRoot = join(root, 'source'), knowledge = join(projectRoot, 'knowledge-base'), output = join(root, 'REFERENCE_LIBRARY');
  await mkdir(knowledge, { recursive: true }); await writeFile(join(knowledge, 'README.md'), 'Reference fixture');
  for (const name of ['shopee-open-platform', 'shopee-uni-vn']) {
    const corpus = join(knowledge, name); await mkdir(join(corpus, 'documents'), { recursive: true });
    await mkdir(join(corpus, 'raw')); await writeFile(join(corpus, 'raw/not-selected.json'), 'not part of retrieval');
    await writeFile(join(corpus, 'documents/guide.md'), 'verified document');
    await writeFile(join(corpus, 'search.sqlite'), 'fixture index');
    await writeFile(join(corpus, 'README.md'), 'Corpus guide');
    const row = { id: 'guide', path: 'documents/guide.md', source_url: 'https://open.shopee.com/documents/guide' };
    row[name === 'shopee-open-platform' ? 'markdown_sha256' : 'sha256'] = digest('verified document');
    await writeFile(join(corpus, 'manifest.json'), JSON.stringify([row]));
  }
  const seller = join(knowledge, 'shopee-seller-observations'); await mkdir(join(seller, 'documents'), { recursive: true });
  await writeFile(join(seller, 'documents/observation.md'), 'private observation');
  await writeFile(join(seller, 'manifest.json'), JSON.stringify({ documents: [{ path: 'documents/observation.md', sha256: digest('private observation') }] }));
  await writeFile(join(seller, 'private-evidence.json'), '{"fixture":true}');
  return { root, projectRoot, knowledge, output };
}
test('exports the exact retrieval closure with optional modest private observations and preserves corpus manifests', async () => {
  const f = await fixture(), m = await api();
  const report = await m.createReferenceLibrary({ projectRoot: f.projectRoot, output: f.output });
  assert.equal(report.verifiedFiles, 12); assert.equal(report.corpora, 2); assert.equal(report.sellerObservationFiles, 3);
  assert.equal(await readFile(join(f.output, 'knowledge-base/shopee-open-platform/raw/not-selected.json')).catch(() => null), null);
  assert.deepEqual(await readFile(join(f.output, 'knowledge-base/shopee-open-platform/manifest.json')), await readFile(join(f.knowledge, 'shopee-open-platform/manifest.json')));
  assert.equal((await m.verifyReferenceLibrary(f.output)).verifiedFiles, 12);
  await assert.rejects(m.createReferenceLibrary({ projectRoot: f.projectRoot, output: f.output }), /OUTPUT_EXISTS/);
});
test('refuses missing, altered, traversing or linked source documents before creating an export', async () => {
  const m = await api();
  for (const mode of ['missing', 'altered', 'traversal', 'linked']) {
    const f = await fixture(), corpus = join(f.knowledge, 'shopee-open-platform');
    if (mode === 'missing') await rm(join(corpus, 'documents/guide.md'));
    if (mode === 'altered') await writeFile(join(corpus, 'documents/guide.md'), 'wrong source');
    if (mode === 'traversal') await writeFile(join(corpus, 'manifest.json'), JSON.stringify([{ path: '../escape.md', markdown_sha256: digest('verified document') }]));
    if (mode === 'linked') { await rename(join(corpus, 'documents'), join(f.root, 'outside')); await symlink(join(f.root, 'outside'), join(corpus, 'documents'), 'junction'); }
    await assert.rejects(m.createReferenceLibrary({ projectRoot: f.projectRoot, output: f.output }));
    assert.equal(await readFile(join(f.output, 'manifest.json')).catch(() => null), null);
  }
});
test('verification rejects content that disagrees with original corpus SHA even when outer hashes are replaced', async () => {
  const f = await fixture(), m = await api(); await m.createReferenceLibrary({ projectRoot: f.projectRoot, output: f.output });
  const path = 'knowledge-base/shopee-uni-vn/documents/guide.md', original = await readFile(join(f.output, 'manifest.json'), 'utf8');
  await writeFile(join(f.output, path), 'tampered');
  await assert.rejects(m.verifyReferenceLibrary(f.output), /CHECKSUM_MISMATCH/);
  const manifest = JSON.parse(original), entry = manifest.files.find(row => row.path === path);
  entry.bytes = Buffer.byteLength('tampered'); entry.sha256 = digest('tampered');
  await writeFile(join(f.output, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(m.verifyReferenceLibrary(f.output), /ENTRY_CHECKSUM_MISMATCH/);
  await writeFile(join(f.output, path), 'verified document'); await writeFile(join(f.output, 'manifest.json'), original);
  await writeFile(join(f.output, 'extra.txt'), 'unexpected');
  await assert.rejects(m.verifyReferenceLibrary(f.output), /UNLISTED_FILE/);
});
test('import plans without writing, copies only into a fresh target and refuses to overwrite that target', async () => {
  const f = await fixture(), m = await api(); await m.createReferenceLibrary({ projectRoot: f.projectRoot, output: f.output });
  const target = join(f.root, 'target'); await mkdir(target);
  assert.equal((await m.importReferenceLibrary({ projectRoot: target, library: f.output })).plannedFiles, 12);
  assert.equal(await readFile(join(target, '.local/reference-library/import-receipt.json')).catch(() => null), null);
  const report = await m.importReferenceLibrary({ projectRoot: target, library: f.output, apply: true });
  assert.equal(report.importedFiles, 12);
  assert.equal(await readFile(join(target, 'knowledge-base/shopee-uni-vn/documents/guide.md'), 'utf8'), 'verified document');
  const receipt = JSON.parse(await readFile(join(target, '.local/reference-library/import-receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'complete'); assert.match(receipt.manifestSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(m.importReferenceLibrary({ projectRoot: target, library: f.output, apply: true }), /TARGET_EXISTS/);
});
test('CLI import is bound to its script checkout and rejects target overrides', async () => {
  const f = await fixture(), m = await api(); await m.createReferenceLibrary({ projectRoot: f.projectRoot, output: f.output });
  const target = join(f.root, 'cli-target'); await mkdir(join(target, 'scripts'), { recursive: true });
  for (const name of ['reference-library.mjs', 'transfer-files.mjs', 'onboarding-core.mjs'])
    await writeFile(join(target, 'scripts', name), await readFile(join(process.cwd(), 'scripts', name)));
  const run = args => spawnSync(process.execPath, [join(target, 'scripts/reference-library.mjs'), ...args], { cwd: f.root, encoding: 'utf8', windowsHide: true });
  const override = run(['import', '--library', f.output, '--root', f.root, '--apply']);
  assert.equal(override.status, 1); assert.match(override.stderr, /ARGUMENTS_INVALID/);
  const child = run(['import', '--library', f.output, '--apply']);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(JSON.parse(child.stdout).importedFiles, 12);
  assert.equal(await readFile(join(f.root, 'knowledge-base/README.md')).catch(() => null), null);
});
