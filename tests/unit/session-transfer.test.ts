import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkpointSession,
  readSessionState,
  loadContextRegistry,
  inspectContextFreshness,
} from '../../packages/agent-runtime/src/session-store.js';
import {
  exportSessionContext,
  verifySessionContextBundle,
  planSessionContextImport,
  importSessionContext,
} from '../../packages/agent-runtime/src/session-transfer.js';
import { contextSha256 } from '../../packages/agent-runtime/src/session-context.js';
const roots: string[] = [];
async function fixture(seed = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'listing-context-transfer-'));
  roots.push(root);
  await mkdir(join(root, 'docs/context'), { recursive: true });
  await mkdir(join(root, '.local'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), 'Do not resume jobs.');
  await writeFile(join(root, 'docs/feature.md'), 'Feature contract.');
  await writeFile(join(root, '.env'), 'MARKER=fixture-not-a-credential');
  await writeFile(
    join(root, 'docs/context/features.json'),
    JSON.stringify({
      version: 1,
      projectId: 'listing-studio',
      coreDocuments: ['AGENTS.md'],
      features: [
        {
          id: 'feature',
          title: 'Feature',
          document: 'docs/feature.md',
          code: [],
          tests: [],
          relatedDocuments: [],
          dependsOn: [],
        },
      ],
    }),
  );
  if (seed) {
    await writeFile(join(root, '.local/receipt.json'), '{"result":"passed"}');
    await checkpointSession(
      root,
      {
        id: 'job',
        title: 'Paused work',
        featureIds: ['feature'],
        status: 'paused',
        goal: 'Keep correct source',
        scope: { description: 'Local transfer only' },
        decisions: ['User paused work'],
        doNotReplay: ['Do not replay completed operation'],
        evidence: ['.local/receipt.json'],
      },
      0,
    );
  }
  return root;
}
async function bundle() {
  const source = await fixture(true);
  const value = await exportSessionContext(source, '.local/context-handoff');
  return { source, ...value };
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir(), 'listing-context-transfer-')))
      throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
describe('private session context transfer', () => {
  it('exports only declared checkpoint/journal/evidence with hashes and no lock or env files', async () => {
    const { source, directory, manifest } = await bundle();
    expect(manifest.files).toHaveLength(3);
    expect(manifest.files.every((file) => file.path.startsWith('.local/'))).toBe(true);
    expect(
      manifest.files.some((file) => file.path.endsWith('.env') || file.path.endsWith('.lock')),
    ).toBe(false);
    expect((await verifySessionContextBundle(directory)).manifest.revision).toBe(1);
    expect((await readSessionState(source)).revision).toBe(1);
  });
  it('plans without mutations and imports exact bytes, decisions and pause state idempotently', async () => {
    const { directory, manifest } = await bundle();
    const target = await fixture();
    const env = await readFile(join(target, '.env'));
    const plan = await planSessionContextImport(target, directory);
    expect(plan.missingPaths).toHaveLength(3);
    expect((await readSessionState(target)).revision).toBe(0);
    const result = await importSessionContext(target, directory);
    expect(result.copiedFiles).toBe(3);
    expect(result.remoteActions).toBe(false);
    const state = await readSessionState(target);
    expect(state.tasks[0]).toMatchObject({
      status: 'paused',
      decisions: ['User paused work'],
      doNotReplay: ['Do not replay completed operation'],
    });
    for (const file of manifest.files)
      expect(contextSha256(await readFile(join(target, file.path)))).toBe(file.sha256);
    expect(await readFile(join(target, '.env'))).toEqual(env);
    expect((await importSessionContext(target, directory)).copiedFiles).toBe(0);
  });
  it('refuses a different checkpoint or evidence and leaves existing data unchanged', async () => {
    const { directory } = await bundle();
    const target = await fixture(true);
    await writeFile(join(target, '.local/receipt.json'), 'different');
    const before = await readFile(join(target, '.local/session-context/state.json'));
    await expect(importSessionContext(target, directory)).rejects.toThrow('TARGET_CONFLICT');
    expect(await readFile(join(target, '.local/session-context/state.json'))).toEqual(before);
    expect(await readFile(join(target, '.local/receipt.json'), 'utf8')).toBe('different');
  });
  it('rejects tampered bytes and unlisted files before any import', async () => {
    const first = await bundle();
    await writeFile(join(first.directory, 'files/.local/receipt.json'), 'tampered');
    await expect(verifySessionContextBundle(first.directory)).rejects.toThrow('HASH_MISMATCH');
    const second = await bundle();
    await writeFile(join(second.directory, 'extra.json'), '{}');
    await expect(verifySessionContextBundle(second.directory)).rejects.toThrow(
      'INVENTORY_MISMATCH',
    );
  });
  it('rejects traversal, Windows aliases and reserved file roles in the manifest', async () => {
    for (const path of ['../outside.json', '.local/NUL.json', '.local/name. ']) {
      const { directory, manifest } = await bundle();
      manifest.files[0].path = path;
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
      await expect(verifySessionContextBundle(directory)).rejects.toThrow('INVALID_OR_SECRET');
    }
    const { directory, manifest } = await bundle();
    manifest.files.find((file) => file.role === 'state')!.role = 'evidence';
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await expect(verifySessionContextBundle(directory)).rejects.toThrow('ROLE_MISMATCH');
  });
  it('preserves missing and changed evidence as explicit exceptions instead of rewriting references', async () => {
    const source = await fixture(true);
    await rm(join(source, '.local/receipt.json'));
    const missing = await exportSessionContext(source, '.local/missing-context');
    expect(missing.manifest.omittedEvidence).toEqual([
      { path: '.local/receipt.json', reason: 'missing' },
    ]);
    const target = await fixture();
    await importSessionContext(target, missing.directory);
    expect(
      (
        await inspectContextFreshness(
          target,
          await loadContextRegistry(target),
          (await readSessionState(target)).tasks,
        )
      )[0].evidence[0].status,
    ).toBe('missing');
    const changed = await fixture(true);
    const original = (await readSessionState(changed)).tasks[0].evidence[0].sha256;
    await writeFile(join(changed, '.local/receipt.json'), 'changed source');
    const value = await exportSessionContext(changed, '.local/changed-context');
    expect(value.manifest.changedEvidence).toEqual(['.local/receipt.json']);
    const receiver = await fixture();
    await importSessionContext(receiver, value.directory);
    expect((await readSessionState(receiver)).tasks[0].evidence[0].sha256).toBe(original);
    expect(
      (
        await inspectContextFreshness(
          receiver,
          await loadContextRegistry(receiver),
          (await readSessionState(receiver)).tasks,
        )
      )[0].evidence[0].status,
    ).toBe('changed');
  });
  it('requires public evidence from the source package and never overwrites code', async () => {
    const source = await fixture(true);
    const task = (await readSessionState(source)).tasks[0];
    await checkpointSession(
      source,
      {
        id: 'job',
        title: task.title,
        featureIds: task.featureIds,
        status: 'paused',
        goal: task.goal,
        scope: task.scope,
        evidence: ['.local/receipt.json', 'AGENTS.md'],
      },
      1,
    );
    const { directory, manifest } = await exportSessionContext(source, '.local/public-evidence');
    expect(manifest.omittedEvidence).toContainEqual({
      path: 'AGENTS.md',
      reason: 'source_package_required',
    });
    const target = await fixture();
    await writeFile(join(target, 'AGENTS.md'), 'Receiving machine rules.');
    await importSessionContext(target, directory);
    expect(await readFile(join(target, 'AGENTS.md'), 'utf8')).toBe('Receiving machine rules.');
    expect(
      (
        await inspectContextFreshness(
          target,
          await loadContextRegistry(target),
          (await readSessionState(target)).tasks,
        )
      )[0].featureChanged,
    ).toBe(true);
  });
  it('checks the underlying journal even when a forged file checksum matches altered state', async () => {
    const { directory, manifest } = await bundle();
    const path = join(directory, 'files/.local/session-context/state.json');
    const state = JSON.parse(await readFile(path, 'utf8'));
    state.tasks[0].goal = 'Forged projection';
    const bytes = Buffer.from(JSON.stringify(state));
    await writeFile(path, bytes);
    const file = manifest.files.find((file) => file.role === 'state')!;
    file.sha256 = contextSha256(bytes);
    file.bytes = bytes.length;
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await expect(verifySessionContextBundle(directory)).rejects.toThrow('JOURNAL_MISMATCH');
  });
  it('resumes a partial local import using only matching files and rejects extra target history', async () => {
    const { directory } = await bundle();
    const target = await fixture();
    await mkdir(join(target, '.local/session-context/journal'), { recursive: true });
    await writeFile(
      join(target, '.local/session-context/journal/00000001.json'),
      await readFile(join(directory, 'files/.local/session-context/journal/00000001.json')),
    );
    expect((await importSessionContext(target, directory)).copiedFiles).toBe(2);
    expect((await readSessionState(target)).revision).toBe(1);
    const other = await fixture();
    await mkdir(join(other, '.local/session-context/journal'), { recursive: true });
    await writeFile(join(other, '.local/session-context/journal/00000002.json'), '{}');
    await expect(importSessionContext(other, directory)).rejects.toThrow('TARGET_HAS_HISTORY');
  });
  it('blocks linked payload directories and an active target checkpoint lock', async () => {
    const { directory } = await bundle();
    const external = await fixture();
    await symlink(
      external,
      join(directory, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(verifySessionContextBundle(directory)).rejects.toThrow('LINK_BLOCKED');
    const clean = await bundle();
    const target = await fixture();
    await mkdir(join(target, '.local/session-context'), { recursive: true });
    await writeFile(
      join(target, '.local/session-context/checkpoint.lock'),
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    await expect(importSessionContext(target, clean.directory)).rejects.toThrow('LOCKED');
    expect((await readSessionState(target)).revision).toBe(0);
  });
  it('requires a private new output and never overwrites an exported bundle', async () => {
    const { source, directory } = await bundle();
    for (const path of ['../context', 'docs/context-export', '.local/session-context/export'])
      await expect(exportSessionContext(source, path)).rejects.toThrow('OUTPUT_INVALID');
    await expect(exportSessionContext(source, '.local/context-handoff')).rejects.toThrow(
      'OUTPUT_EXISTS',
    );
    expect((await verifySessionContextBundle(directory)).manifest.revision).toBe(1);
  });
});
