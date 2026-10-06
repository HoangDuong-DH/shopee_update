import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkpointSession,
  readSessionState,
  loadContextRegistry,
  inspectContextFreshness,
  recoverSession,
  checkedContextPath,
  readContextHistory,
  readContextChanges,
  releaseAbandonedContextLock,
  contextRepositoryHead,
  contextWorkingTreeFingerprint,
} from '../../packages/agent-runtime/src/session-store.js';
const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'listing-context-'));
  roots.push(root);
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'docs/context'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.local'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), 'Do not resume jobs.');
  await writeFile(join(root, 'docs/feature.md'), 'Feature rules.');
  await writeFile(join(root, 'src/feature.ts'), 'export const value = 1;');
  await writeFile(join(root, '.local/receipt.json'), '{"result":"passed"}');
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
          code: ['src/feature.ts'],
          tests: [],
          relatedDocuments: [],
          dependsOn: [],
        },
      ],
    }),
  );
  return root;
}
async function gitFixture(root: string): Promise<void> {
  await writeFile(join(root, '.gitignore'), '.local/\n');
  const excludeFile = join(root, '.local/empty-ignore');
  await writeFile(excludeFile, '');
  for (const args of [
    ['init', '--quiet'],
    ['add', '--all'],
    [
      '-c',
      'user.name=Context fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Fixture',
    ],
  ]) {
    const result = spawnSync('git', ['-c', 'core.excludesFile=' + excludeFile, ...args], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    if (result.status !== 0) throw new Error('Fixture git failed: ' + result.stderr);
  }
}
const patch = (extra: Record<string, unknown> = {}) => ({
  id: 'job',
  title: 'Local job',
  featureIds: ['feature'],
  status: 'active',
  goal: 'Read only',
  scope: { description: 'Local' },
  evidence: ['.local/receipt.json'],
  ...extra,
});
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir(), 'listing-context-')))
      throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

describe('durable session store', () => {
  it('starts honestly empty without creating a store during inspection', async () => {
    const root = await fixture();
    expect((await readSessionState(root)).revision).toBe(0);
    expect(await readdir(join(root, '.local'))).toEqual(['receipt.json']);
  });
  it('writes immutable revisions and reads current state/history/deltas', async () => {
    const root = await fixture();
    await checkpointSession(root, patch(), 0);
    await checkpointSession(root, patch({ decisions: ['Keep paused batches'] }), 1);
    expect((await readSessionState(root)).revision).toBe(2);
    expect(await readdir(join(root, '.local/session-context/journal'))).toEqual([
      '00000001.json',
      '00000002.json',
    ]);
    expect(await readContextHistory(root, 'job', 1)).toHaveLength(1);
    const changes = await readContextChanges(root, 0, 1);
    expect(changes.hasMore).toBe(true);
    expect(changes.toRevision).toBe(1);
    expect((await readContextChanges(root, 1, 1)).hasMore).toBe(false);
    await expect(readContextChanges(root, 3)).rejects.toThrow('HISTORY_INVALID');
  });
  it('does not overwrite when concurrent checkpoints compete', async () => {
    const root = await fixture();
    const result = await Promise.allSettled([
      checkpointSession(root, patch(), 0),
      checkpointSession(root, patch({ id: 'second' }), 0),
    ]);
    expect(result.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect((await readSessionState(root)).revision).toBe(1);
    await expect(checkpointSession(root, patch(), 0)).rejects.toThrow('REVISION_CONFLICT');
  });
  it('detects changed code and changed/missing evidence without mutating saved state', async () => {
    const root = await fixture();
    const state = await checkpointSession(root, patch(), 0);
    const registry = await loadContextRegistry(root);
    expect((await inspectContextFreshness(root, registry, state.tasks))[0].featureChanged).toBe(
      false,
    );
    await writeFile(join(root, 'src/feature.ts'), 'export const value = 2;');
    await writeFile(join(root, '.local/receipt.json'), '{"result":"different"}');
    const changed = (await inspectContextFreshness(root, registry, state.tasks))[0];
    expect(changed.featureChanged).toBe(true);
    expect(changed.evidence[0].status).toBe('changed');
    await rm(join(root, '.local/receipt.json'));
    expect((await inspectContextFreshness(root, registry, state.tasks))[0].evidence[0].status).toBe(
      'missing',
    );
    expect((await readSessionState(root)).revision).toBe(1);
  });
  it('does not inherit a parent checkout HEAD when context belongs to a standalone directory', async () => {
    const root = await fixture();
    await gitFixture(root);
    const child = join(root, 'standalone');
    await mkdir(child);
    expect(contextRepositoryHead(root)).toMatch(/^[a-f0-9]{40}$/);
    expect(contextRepositoryHead(child)).toBe('unavailable');
    const state = await checkpointSession(root, patch(), 0);
    const registry = await loadContextRegistry(root);
    const unknown = structuredClone(state.tasks);
    unknown[0].repository.head = 'unavailable';
    expect((await inspectContextFreshness(root, registry, unknown))[0].headChanged).toBe(
      'not_recorded',
    );
    expect(await contextWorkingTreeFingerprint(child)).toBe('unavailable');
  });
  it('flags uncommitted code outside feature entrypoints and excludes private receipt changes', async () => {
    const root = await fixture();
    await gitFixture(root);
    const state = await checkpointSession(root, patch(), 0);
    const registry = await loadContextRegistry(root);
    expect((await inspectContextFreshness(root, registry, state.tasks))[0].repositoryChanged).toBe(
      false,
    );
    await writeFile(join(root, '.local/receipt.json'), 'private result changed');
    expect((await inspectContextFreshness(root, registry, state.tasks))[0].repositoryChanged).toBe(
      false,
    );
    await writeFile(join(root, 'src/other.ts'), 'export const unrelated = true;');
    const changed = (await inspectContextFreshness(root, registry, state.tasks))[0];
    expect(changed.featureChanged).toBe(false);
    expect(changed.repositoryChanged).toBe(true);
    const staged = spawnSync('git', ['add', 'src/other.ts'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    expect(staged.status).toBe(0);
    expect((await inspectContextFreshness(root, registry, state.tasks))[0].repositoryChanged).toBe(
      true,
    );
    const legacy = structuredClone(state.tasks);
    delete legacy[0].repository.workingTreeFingerprint;
    expect((await inspectContextFreshness(root, registry, legacy))[0].repositoryChanged).toBe(
      'not_recorded',
    );
  });
  it('uses project ignore rules without changing machine-specific Git configuration', async () => {
    const root = await fixture();
    await gitFixture(root);
    const customIgnore = join(root, '.local/custom-ignore');
    await writeFile(customIgnore, 'src/ignored.ts\n');
    const configured = spawnSync('git', ['config', 'core.excludesFile', customIgnore], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    expect(configured.status).toBe(0);
    const state = await checkpointSession(root, patch(), 0);
    const registry = await loadContextRegistry(root);
    await writeFile(join(root, 'src/ignored.ts'), 'export const changed = true;');
    expect((await inspectContextFreshness(root, registry, state.tasks))[0].repositoryChanged).toBe(
      true,
    );
    const readback = spawnSync('git', ['config', '--get', 'core.excludesFile'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    expect(readback.stdout.trim()).toBe(customIgnore);
  });
  it('surfaces an interrupted commit and recovers only the hashed local event', async () => {
    const root = await fixture();
    await checkpointSession(root, patch(), 0);
    const stateFile = join(root, '.local/session-context/state.json');
    const prior = await readFile(stateFile);
    await checkpointSession(root, patch({ observations: ['Verified once'] }), 1);
    await writeFile(stateFile, prior);
    await expect(readSessionState(root)).rejects.toThrow('RECOVERY_REQUIRED');
    const recovered = await recoverSession(root, 1);
    expect(recovered.revision).toBe(2);
    expect(recovered.tasks[0].observations).toEqual(['Verified once']);
    expect((await readSessionState(root)).revision).toBe(2);
  });
  it('refuses a tampered recovery event and corrupt state instead of resetting', async () => {
    const root = await fixture();
    await checkpointSession(root, patch(), 0);
    const stateFile = join(root, '.local/session-context/state.json');
    const prior = await readFile(stateFile);
    await checkpointSession(root, patch(), 1);
    await writeFile(stateFile, prior);
    const eventFile = join(root, '.local/session-context/journal/00000002.json');
    const event = JSON.parse(await readFile(eventFile, 'utf8'));
    event.task.goal = 'Tampered';
    await writeFile(eventFile, JSON.stringify(event));
    await expect(recoverSession(root, 1)).rejects.toThrow('JOURNAL_MISMATCH');
    expect(await readFile(stateFile)).toEqual(prior);
    await writeFile(stateFile, '{broken');
    await expect(readSessionState(root)).rejects.toThrow('JSON_INVALID');
    expect(await readFile(stateFile, 'utf8')).toBe('{broken');
  });
  it('can read legacy checkpoints but labels missing event digests instead of inventing integrity', async () => {
    const root = await fixture();
    await checkpointSession(root, patch(), 0);
    const eventFile = join(root, '.local/session-context/journal/00000001.json');
    const event = JSON.parse(await readFile(eventFile, 'utf8'));
    delete event.eventDigest;
    await writeFile(eventFile, JSON.stringify(event));
    expect((await readSessionState(root)).revision).toBe(1);
    expect((await readContextHistory(root, 'job'))[0]).toMatchObject({ integrity: 'not_recorded' });
    expect((await readContextChanges(root, 0)).changes[0]).toMatchObject({
      integrity: 'not_recorded',
    });
  });
  it('rejects altered journal events in current state, history and delta reads', async () => {
    const root = await fixture();
    await checkpointSession(root, patch(), 0);
    const eventFile = join(root, '.local/session-context/journal/00000001.json');
    const event = JSON.parse(await readFile(eventFile, 'utf8'));
    event.task.goal = 'Changed journal';
    await writeFile(eventFile, JSON.stringify(event));
    await expect(readSessionState(root)).rejects.toThrow('JOURNAL_MISMATCH');
    await expect(readContextHistory(root, 'job')).rejects.toThrow('JOURNAL_MISMATCH');
    await expect(readContextChanges(root, 0)).rejects.toThrow('JOURNAL_MISMATCH');
  });
  it('blocks traversal, private manifest documents, and a linked evidence directory', async () => {
    const root = await fixture();
    await expect(checkedContextPath(root, '../outside')).rejects.toThrow('UNSAFE_PATH');
    const external = await fixture();
    await symlink(
      join(external, '.local'),
      join(root, '.local/linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      checkpointSession(root, patch({ evidence: ['.local/linked/receipt.json'] }), 0),
    ).rejects.toThrow('LINK_BLOCKED');
    const path = join(root, 'docs/context/features.json');
    const registry = JSON.parse(await readFile(path, 'utf8'));
    registry.features[0].document = '.local/receipt.json';
    await writeFile(path, JSON.stringify(registry));
    await expect(loadContextRegistry(root)).rejects.toThrow('INVALID_OR_SECRET');
  });
  it('requires referenced public files and valid completion evidence', async () => {
    const root = await fixture();
    await rm(join(root, 'src/feature.ts'));
    await expect(loadContextRegistry(root)).rejects.toThrow();
    await writeFile(join(root, 'src/feature.ts'), 'value');
    await expect(
      checkpointSession(root, patch({ status: 'done', evidence: [] }), 0),
    ).rejects.toThrow('COMPLETION_EVIDENCE_REQUIRED');
    expect((await checkpointSession(root, patch({ status: 'done' }), 0)).tasks[0].status).toBe(
      'done',
    );
  });
  it('never automatically drops a lock or unlocks a live process', async () => {
    const root = await fixture();
    await mkdir(join(root, '.local/session-context'), { recursive: true });
    await writeFile(
      join(root, '.local/session-context/checkpoint.lock'),
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    await expect(checkpointSession(root, patch(), 0)).rejects.toThrow('LOCKED');
    await expect(releaseAbandonedContextLock(root, process.pid)).rejects.toThrow(
      'LOCK_OWNER_ALIVE',
    );
    await expect(releaseAbandonedContextLock(root, process.pid + 1)).rejects.toThrow(
      'LOCK_OWNER_CHANGED',
    );
  });
});
