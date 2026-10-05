import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync, strFromU8 } from 'fflate';
import { isReleasePath, createSourceRelease } from '../scripts/release-package.mjs';

test('release excludes private and generated files', () => {
  for (const path of ['package.json', 'apps/web/src/main.tsx', 'packages/domain/src/index.ts', 'docs/onboarding/START_HERE.md', 'skills/shopee-uploader-operator/SKILL.md', '.env.example', 'SETUP_LISTINGSTUDIO.cmd', 'tests/fixtures/source-catalog.ts']) assert.ok(isReleasePath(path), path);
  for (const path of ['.env', '.local/credentials.json', 'outputs/result.xlsx', 'tmp/plan.json', 'apps/web/dist/index.html', 'node_modules/pkg/index.js', 'knowledge-base/raw.html', 'tests/fixtures/private/item.json', 'docs/delivery/2026-01-01.md', '.git/config', 'docs/sources/file.xlsx', 'packages/domain/tsconfig.tsbuildinfo', '../secret', 'C:/secret', 'scripts/run-production-pilot.mts']) assert.equal(isReleasePath(path), false, path);
});

test('archive preserves bytes and records hashes without private files', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'listing-release-test-'));
  try {
    const root = join(temp, 'source');
    await mkdir(join(root, 'apps/web/src'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"test"}\n');
    await writeFile(join(root, 'apps/web/src/main.tsx'), 'export const name = "Nguồn gốc";\n');
    await writeFile(join(root, '.env'), 'PRIVATE_VALUE=must-not-leak');
    const result = await createSourceRelease({ root, output: join(temp, 'release'), candidates: ['package.json', 'apps/web/src/main.tsx', '.env'], revision: 'test-fixture' });
    const zip = unzipSync(await readFile(result.archive));
    assert.deepEqual(Object.keys(zip).sort(), ['RELEASE_MANIFEST.json', 'apps/web/src/main.tsx', 'package.json']);
    const manifest = JSON.parse(strFromU8(zip['RELEASE_MANIFEST.json']));
    assert.equal(manifest.files.length, 2);
    assert.match(manifest.files[0].sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(zip['apps/web/src/main.tsx'], new Uint8Array(await readFile(join(root, 'apps/web/src/main.tsx'))));
    assert.equal(manifest.databaseIncluded, false);
    assert.equal(manifest.credentialsIncluded, false);
    await assert.rejects(createSourceRelease({ root, output: join(temp, 'release'), candidates: ['package.json'], revision: 'test-fixture' }), /already exists|đã tồn tại/i);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('rejects source paths through symlinks', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'listing-release-test-'));
  try {
    const root = join(temp, 'source'); const external = join(temp, 'external');
    await mkdir(root); await mkdir(external);
    await writeFile(join(external, 'private.ts'), 'private source');
    await symlink(external, join(root, 'apps'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(createSourceRelease({ root, output: join(temp, 'release'), candidates: ['apps/private.ts'], revision: 'test-fixture' }), /symlink|symbolic|liên kết/i);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('real credential assignment blocks export from an allowed file', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'listing-release-test-'));
  try {
    const root = join(temp, 'source'); await mkdir(root);
    await writeFile(join(root, 'README.md'), 'APP_ENCRYPTION_KEY=' + 'a'.repeat(64));
    await assert.rejects(createSourceRelease({ root, output: join(temp, 'release'), candidates: ['README.md'], revision: 'test-fixture' }), /credential|khóa|secret/i);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
