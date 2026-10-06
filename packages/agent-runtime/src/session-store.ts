import {
  open,
  readFile,
  writeFile,
  mkdir,
  rename,
  unlink,
  lstat,
  realpath,
  readdir,
} from 'node:fs/promises';
import { resolve, relative, sep, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  MAX_CONTEXT_FILE_BYTES,
  applySessionCheckpoint,
  contextSha256,
  contextFeatureRegistrySchema,
  emptySessionState,
  isContextPath,
  parseContext,
  selectContextDocuments,
  sessionStateSchema,
  sessionTaskPatchSchema,
  sessionTaskSchema,
  type ContextFeatureRegistry,
  type ContextFreshness,
  type SessionState,
  type SessionTask,
  type SessionTaskPatch,
} from './session-context.js';

const storePath = '.local/session-context';
const statePath = `${storePath}/state.json`;
const lockPath = `${storePath}/checkpoint.lock`;
const journal = (revision: number): string =>
  `${storePath}/journal/${String(revision).padStart(8, '0')}.json`;
const eventSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().positive(),
    previousDigest: z.string().regex(/^[a-f0-9]{64}$/),
    resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
    updatedAt: z.string().datetime(),
    focusTaskId: z.string(),
    task: sessionTaskSchema,
    eventDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
const serialize = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
function readContextEvent(bytes: Buffer): z.infer<typeof eventSchema> {
  const event = parseContext(eventSchema, json(bytes));
  const { eventDigest, ...body } = event;
  if (eventDigest && contextSha256(serialize(body)) !== eventDigest)
    throw new Error('SESSION_CONTEXT_JOURNAL_MISMATCH');
  return event;
}
const contextEventIntegrity = (event: z.infer<typeof eventSchema>) =>
  event.eventDigest ? 'hash_matches' : 'not_recorded';

export async function checkedContextPath(
  root: string,
  path: string,
  publicOnly = false,
): Promise<string> {
  if (!isContextPath(path, publicOnly)) throw new Error('SESSION_CONTEXT_UNSAFE_PATH');
  const base = await realpath(root);
  const full = resolve(base, ...path.split('/'));
  const rel = relative(base, full);
  if (rel === '..' || rel.startsWith('..' + sep) || resolve(base, rel) !== full)
    throw new Error('SESSION_CONTEXT_UNSAFE_PATH');
  let current = base;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('SESSION_CONTEXT_LINK_BLOCKED');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  return full;
}
export async function readContextFile(
  root: string,
  path: string,
  publicOnly = false,
  maxBytes = MAX_CONTEXT_FILE_BYTES,
): Promise<Buffer> {
  const full = await checkedContextPath(root, path, publicOnly);
  const info = await lstat(full);
  if (!info.isFile() || info.size > maxBytes) throw new Error('SESSION_CONTEXT_FILE_INVALID');
  const bytes = await readFile(full);
  if (bytes.length > maxBytes) throw new Error('SESSION_CONTEXT_FILE_INVALID');
  return bytes;
}
function json(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('SESSION_CONTEXT_JSON_INVALID');
  }
}
async function exists(root: string, path: string): Promise<boolean> {
  try {
    await lstat(await checkedContextPath(root, path));
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}
export async function loadContextRegistry(root: string): Promise<ContextFeatureRegistry> {
  const registry = parseContext(
    contextFeatureRegistrySchema,
    json(await readContextFile(root, 'docs/context/features.json', true, 128 * 1024)),
  );
  const paths = new Set([
    ...registry.coreDocuments,
    ...registry.features.flatMap((feature) => [
      feature.document,
      ...feature.code,
      ...feature.tests,
      ...feature.relatedDocuments,
    ]),
  ]);
  for (const path of paths) {
    const full = await checkedContextPath(root, path, true);
    if (!(await lstat(full)).isFile()) throw new Error('SESSION_CONTEXT_REGISTRY_FILE_MISSING');
  }
  return registry;
}
export function contextRepositoryHead(root: string): string {
  if (!existsSync(resolve(root, '.git'))) return 'unavailable';
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 4096,
  });
  const head = result.status === 0 ? result.stdout.trim() : '';
  return /^[a-f0-9]{40,64}$/.test(head) ? head : 'unavailable';
}
export async function contextWorkingTreeFingerprint(root: string): Promise<string> {
  if (!existsSync(resolve(root, '.git'))) return 'unavailable';
  if (contextRepositoryHead(root) === 'unavailable') return 'unavailable';
  // Use this checkout's ignore rules without relying on machine-specific global files.
  const result = spawnSync(
    'git',
    [
      '-c',
      'core.excludesFile=' + resolve(root, '.gitignore'),
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 512 * 1024,
    },
  );
  if (result.status !== 0) return 'unavailable';
  const entries = result.stdout.split('\0');
  const changedPaths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    if (entry[2] !== ' ' || !/^([ MADRCUT?!]){2}$/.test(status)) return 'unavailable';
    changedPaths.push(entry.slice(3));
    if (/[RC]/.test(status)) {
      const original = entries[++index];
      if (!original) return 'unavailable';
      changedPaths.push(original);
    }
  }
  const paths = [...new Set(changedPaths.filter((path) => isContextPath(path, true)))].sort();
  if (paths.length > 2000) return 'unavailable';
  const hashes: string[] = [];
  for (const path of paths) {
    try {
      hashes.push(path + ':' + contextSha256(await readContextFile(root, path, true)));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') hashes.push(path + ':deleted');
      else return 'unavailable';
    }
  }
  return contextSha256(hashes.join('\n'));
}

export async function contextFeatureFingerprint(
  root: string,
  registry: ContextFeatureRegistry,
  featureIds: string[],
): Promise<string> {
  const selection = selectContextDocuments(registry, featureIds);
  const paths = [
    ...new Set([
      'docs/context/features.json',
      ...selection.documents,
      ...selection.features.flatMap((feature) => feature.code),
    ]),
  ].sort();
  const hashes: string[] = [];
  for (const path of paths)
    hashes.push(`${path}:${contextSha256(await readContextFile(root, path, true))}`);
  return contextSha256(hashes.join('\n'));
}
async function baseState(root: string): Promise<SessionState> {
  if (!(await exists(root, statePath))) return emptySessionState();
  return parseContext(sessionStateSchema, json(await readContextFile(root, statePath)));
}
export async function readSessionState(root: string): Promise<SessionState> {
  const state = await baseState(root);
  if (state.revision) {
    const event = readContextEvent(await readContextFile(root, journal(state.revision)));
    if (
      event.revision !== state.revision ||
      event.resultDigest !== contextSha256(serialize(state)) ||
      event.focusTaskId !== state.focusTaskId ||
      event.updatedAt !== state.updatedAt ||
      serialize(event.task) !== serialize(state.tasks.find((task) => task.id === event.task.id))
    )
      throw new Error('SESSION_CONTEXT_JOURNAL_MISMATCH');
  }
  if (await exists(root, journal(state.revision + 1)))
    throw new Error('SESSION_CONTEXT_RECOVERY_REQUIRED');
  return state;
}
export async function inspectContextFreshness(
  root: string,
  registry: ContextFeatureRegistry,
  tasks: SessionTask[],
): Promise<ContextFreshness[]> {
  const head = contextRepositoryHead(root);
  const workingTree = await contextWorkingTreeFingerprint(root);
  const fingerprints = new Map<string, string>();
  const results: ContextFreshness[] = [];
  for (const task of tasks) {
    const key = [...task.featureIds].sort().join(',');
    if (!fingerprints.has(key))
      fingerprints.set(key, await contextFeatureFingerprint(root, registry, task.featureIds));
    const evidence: ContextFreshness['evidence'] = [];
    for (const entry of task.evidence) {
      try {
        evidence.push({
          path: entry.path,
          status:
            contextSha256(await readContextFile(root, entry.path)) === entry.sha256
              ? 'matches'
              : 'changed',
        });
      } catch (error) {
        evidence.push({
          path: entry.path,
          status: errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable',
        });
      }
    }
    results.push({
      taskId: task.id,
      headChanged:
        head === 'unavailable' || task.repository.head === 'unavailable'
          ? 'not_recorded'
          : head !== task.repository.head,
      repositoryChanged:
        !task.repository.workingTreeFingerprint ||
        workingTree === 'unavailable' ||
        task.repository.workingTreeFingerprint === 'unavailable'
          ? 'not_recorded'
          : workingTree !== task.repository.workingTreeFingerprint,
      featureChanged: fingerprints.get(key) !== task.repository.featureFingerprint,
      evidence,
    });
  }
  return results;
}
async function writeAtomic(root: string, path: string, value: unknown): Promise<void> {
  const bytes = serialize(value);
  if (Buffer.byteLength(bytes) > MAX_CONTEXT_FILE_BYTES)
    throw new Error('SESSION_CONTEXT_FILE_INVALID');
  const full = await checkedContextPath(root, path);
  await mkdir(dirname(full), { recursive: true });
  const temp = `${full}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await checkedContextPath(root, path);
    await rename(temp, full);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}
async function withLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const full = await checkedContextPath(root, lockPath);
  await mkdir(dirname(full), { recursive: true });
  let handle;
  try {
    handle = await open(full, 'wx', 0o600);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') throw new Error('SESSION_CONTEXT_LOCKED');
    throw error;
  }
  try {
    await handle.writeFile(serialize({ pid: process.pid, createdAt: new Date().toISOString() }));
    await handle.sync();
    return await work();
  } finally {
    await handle.close();
    await unlink(full);
  }
}
export async function withContextStoreLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  return withLock(root, work);
}
export async function checkpointSession(
  root: string,
  patchValue: unknown,
  expectedRevision: number,
): Promise<SessionState> {
  const patch = parseContext(sessionTaskPatchSchema, patchValue);
  return withLock(root, async () => {
    const state = await readSessionState(root);
    if (state.revision !== expectedRevision) throw new Error('SESSION_CONTEXT_REVISION_CONFLICT');
    const registry = await loadContextRegistry(root);
    selectContextDocuments(registry, patch.featureIds);
    const evidence: SessionTask['evidence'] = [];
    for (const path of patch.evidence)
      evidence.push({ path, sha256: contextSha256(await readContextFile(root, path)) });
    const next = applySessionCheckpoint({
      state,
      patch,
      expectedRevision,
      now: new Date().toISOString(),
      evidence,
      repository: {
        head: contextRepositoryHead(root),
        featureFingerprint: await contextFeatureFingerprint(root, registry, patch.featureIds),
        workingTreeFingerprint: await contextWorkingTreeFingerprint(root),
      },
    });
    const task = next.tasks.find((task) => task.id === patch.id)!;
    const eventBody = {
      version: 1,
      revision: next.revision,
      previousDigest: contextSha256(serialize(state)),
      resultDigest: contextSha256(serialize(next)),
      updatedAt: next.updatedAt,
      focusTaskId: next.focusTaskId!,
      task,
    };
    const event = { ...eventBody, eventDigest: contextSha256(serialize(eventBody)) };
    if (
      Buffer.byteLength(serialize(event)) > MAX_CONTEXT_FILE_BYTES ||
      Buffer.byteLength(serialize(next)) > MAX_CONTEXT_FILE_BYTES
    )
      throw new Error('SESSION_CONTEXT_FILE_INVALID');
    const full = await checkedContextPath(root, journal(next.revision));
    await mkdir(dirname(full), { recursive: true });
    const handle = await open(full, 'wx', 0o600);
    try {
      await handle.writeFile(serialize(event));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await writeAtomic(root, statePath, next);
    return next;
  });
}
export async function recoverSession(
  root: string,
  expectedRevision: number,
): Promise<SessionState> {
  return withLock(root, async () => {
    const state = await baseState(root);
    if (state.revision !== expectedRevision) throw new Error('SESSION_CONTEXT_REVISION_CONFLICT');
    const event = readContextEvent(await readContextFile(root, journal(state.revision + 1)));
    if (
      event.revision !== state.revision + 1 ||
      event.previousDigest !== contextSha256(serialize(state)) ||
      event.focusTaskId !== event.task.id
    )
      throw new Error('SESSION_CONTEXT_JOURNAL_MISMATCH');
    const next = parseContext(sessionStateSchema, {
      ...state,
      revision: event.revision,
      updatedAt: event.updatedAt,
      focusTaskId: event.focusTaskId,
      tasks: state.tasks.some((task) => task.id === event.task.id)
        ? state.tasks.map((task) => (task.id === event.task.id ? event.task : task))
        : [...state.tasks, event.task],
    });
    if (contextSha256(serialize(next)) !== event.resultDigest)
      throw new Error('SESSION_CONTEXT_JOURNAL_MISMATCH');
    await writeAtomic(root, statePath, next);
    return next;
  });
}
export async function releaseAbandonedContextLock(
  root: string,
  expectedPid: number,
): Promise<void> {
  const full = await checkedContextPath(root, lockPath);
  const lock = parseContext(
    z.object({ pid: z.number().int().positive(), createdAt: z.string().datetime() }).strict(),
    json(await readContextFile(root, lockPath, false, 4096)),
  );
  if (lock.pid !== expectedPid) throw new Error('SESSION_CONTEXT_LOCK_OWNER_CHANGED');
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    if (errorCode(error) === 'ESRCH') {
      const current = json(await readContextFile(root, lockPath, false, 4096));
      if (serialize(current) !== serialize(lock))
        throw new Error('SESSION_CONTEXT_LOCK_OWNER_CHANGED');
      await unlink(full);
      return;
    }
    throw new Error('SESSION_CONTEXT_LOCK_OWNER_UNKNOWN');
  }
  throw new Error('SESSION_CONTEXT_LOCK_OWNER_ALIVE');
}
export async function readContextHistory(
  root: string,
  taskId: string,
  limit = 5,
): Promise<unknown[]> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(taskId) || !Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error('SESSION_CONTEXT_HISTORY_INVALID');
  const dir = await checkedContextPath(root, `${storePath}/journal`);
  let files: string[];
  try {
    files = (await readdir(dir))
      .filter((name) => /^\d{8}\.json$/.test(name))
      .sort()
      .reverse();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  const found: unknown[] = [];
  for (const file of files) {
    const event = readContextEvent(await readContextFile(root, `${storePath}/journal/${file}`));
    if (event.revision !== Number(file.slice(0, 8)))
      throw new Error('SESSION_CONTEXT_JOURNAL_MISMATCH');
    if (event.task.id === taskId) found.push({ ...event, integrity: contextEventIntegrity(event) });
    if (found.length === limit) break;
  }
  return found;
}
export async function readSessionPatch(root: string, path: string): Promise<SessionTaskPatch> {
  return parseContext(
    sessionTaskPatchSchema,
    json(await readContextFile(root, path, false, 128 * 1024)),
  );
}
export async function readContextChanges(
  root: string,
  sinceRevision: number,
  limit = 5,
): Promise<{
  fromRevision: number;
  toRevision: number;
  currentRevision: number;
  hasMore: boolean;
  changes: unknown[];
}> {
  const state = await readSessionState(root);
  if (
    !Number.isSafeInteger(sinceRevision) ||
    sinceRevision < 0 ||
    sinceRevision > state.revision ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20
  )
    throw new Error('SESSION_CONTEXT_HISTORY_INVALID');
  const toRevision = Math.min(state.revision, sinceRevision + limit);
  const changes: unknown[] = [];
  for (let revision = sinceRevision + 1; revision <= toRevision; revision++) {
    const event = readContextEvent(await readContextFile(root, journal(revision)));
    if (event.revision !== revision) throw new Error('SESSION_CONTEXT_JOURNAL_MISMATCH');
    changes.push({
      revision,
      updatedAt: event.updatedAt,
      task: event.task,
      integrity: contextEventIntegrity(event),
    });
  }
  return {
    fromRevision: sinceRevision,
    toRevision,
    currentRevision: state.revision,
    hasMore: toRevision < state.revision,
    changes,
  };
}
