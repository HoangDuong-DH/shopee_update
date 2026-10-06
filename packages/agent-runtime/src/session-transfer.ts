import { mkdir, readdir, lstat, readFile, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  contextSha256,
  isContextPath,
  parseContext,
  sessionStateSchema,
  sessionTaskSchema,
  MAX_CONTEXT_FILE_BYTES,
} from './session-context.js';
import {
  checkedContextPath,
  readContextFile,
  readSessionState,
  readContextChanges,
  withContextStoreLock,
} from './session-store.js';
const STATE = '.local/session-context/state.json';
const STORE = '.local/session-context/';
const MAX_FILES = 4096;
const MAX_BYTES = 64 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const privatePath = z
  .string()
  .refine((path) => path.startsWith('.local/') && isContextPath(path), 'PRIVATE_PATH_REQUIRED');
function roleFor(path: string): 'state' | 'journal' | 'evidence' {
  if (path === STATE) return 'state';
  if (/^\.local\/session-context\/journal\/\d{8}\.json$/.test(path)) return 'journal';
  if (path.startsWith(STORE)) throw new Error('SESSION_CONTEXT_TRANSFER_RESERVED_PATH');
  return 'evidence';
}
const manifestSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('listingstudio-private-session-context'),
    bundleId: z.string().uuid(),
    createdAt: z.string().datetime(),
    revision: z.number().int().positive(),
    files: z
      .array(
        z
          .object({
            path: privatePath,
            role: z.enum(['state', 'journal', 'evidence']),
            bytes: z.number().int().nonnegative().max(MAX_CONTEXT_FILE_BYTES),
            sha256: digest,
          })
          .strict(),
      )
      .min(2)
      .max(MAX_FILES),
    omittedEvidence: z
      .array(
        z
          .object({
            path: z.string().refine((path) => isContextPath(path)),
            reason: z.enum(['missing', 'source_package_required']),
          })
          .strict(),
      )
      .max(MAX_FILES),
    changedEvidence: z.array(privatePath).max(MAX_FILES),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.files.map((file) => file.path.toLowerCase())).size !== value.files.length)
      ctx.addIssue({ code: 'custom', message: 'DUPLICATE_FILE' });
    if (value.files.reduce((sum, file) => sum + file.bytes, 0) > MAX_BYTES)
      ctx.addIssue({ code: 'custom', message: 'TRANSFER_TOO_LARGE' });
  });
type Manifest = z.infer<typeof manifestSchema>;
async function exists(root: string, path: string): Promise<boolean> {
  try {
    await lstat(await checkedContextPath(root, path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function writeNew(root: string, path: string, bytes: Uint8Array): Promise<void> {
  const full = await checkedContextPath(root, path);
  await mkdir(dirname(full), { recursive: true });
  await checkedContextPath(root, path);
  const handle = await open(full, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function inventory(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  const full = prefix ? await checkedContextPath(root, prefix) : resolve(root);
  for (const entry of await readdir(full, { withFileTypes: true })) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (!isContextPath(path)) throw new Error('SESSION_CONTEXT_TRANSFER_UNSAFE_INVENTORY');
    if (entry.isSymbolicLink()) throw new Error('SESSION_CONTEXT_LINK_BLOCKED');
    if (entry.isDirectory()) result.push(...(await inventory(root, path)));
    else if (entry.isFile()) result.push(path);
    else throw new Error('SESSION_CONTEXT_TRANSFER_FILE_INVALID');
    if (result.length > MAX_FILES + 1) throw new Error('SESSION_CONTEXT_TRANSFER_LIMIT');
  }
  return result.sort();
}
function decode(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('SESSION_CONTEXT_JSON_INVALID');
  }
}
async function allEvidence(root: string, revision: number): Promise<Map<string, Set<string>>> {
  const proofs = new Map<string, Set<string>>();
  const add = (task: z.infer<typeof sessionTaskSchema>) => {
    for (const proof of task.evidence) {
      const values = proofs.get(proof.path) ?? new Set<string>();
      values.add(proof.sha256);
      proofs.set(proof.path, values);
    }
  };
  for (let cursor = 0; cursor < revision;) {
    const page = await readContextChanges(root, cursor, 20);
    for (const entry of page.changes) {
      const task = parseContext(z.object({ task: sessionTaskSchema }).passthrough(), entry).task;
      add(task);
    }
    cursor = page.toRevision;
  }
  return proofs;
}
export async function exportSessionContext(
  root: string,
  outputPath: string,
): Promise<{ directory: string; manifest: Manifest }> {
  if (
    !outputPath.startsWith('.local/') ||
    !isContextPath(outputPath) ||
    outputPath.startsWith(STORE)
  )
    throw new Error('SESSION_CONTEXT_TRANSFER_OUTPUT_INVALID');
  const state = await readSessionState(root);
  if (!state.revision) throw new Error('SESSION_CONTEXT_TRANSFER_EMPTY');
  if (state.revision + 1 > MAX_FILES) throw new Error('SESSION_CONTEXT_TRANSFER_LIMIT');
  const proofs = await allEvidence(root, state.revision);
  const paths = new Set<string>([STATE]);
  for (let revision = 1; revision <= state.revision; revision++)
    paths.add(STORE + 'journal/' + String(revision).padStart(8, '0') + '.json');
  const omittedEvidence: Manifest['omittedEvidence'] = [];
  for (const path of proofs.keys()) {
    if (!path.startsWith('.local/')) {
      omittedEvidence.push({ path, reason: 'source_package_required' });
      continue;
    }
    roleFor(path);
    if (await exists(root, path)) paths.add(path);
    else omittedEvidence.push({ path, reason: 'missing' });
  }
  if (paths.size > MAX_FILES) throw new Error('SESSION_CONTEXT_TRANSFER_LIMIT');
  const directory = await checkedContextPath(root, outputPath);
  if (await exists(root, outputPath)) throw new Error('SESSION_CONTEXT_TRANSFER_OUTPUT_EXISTS');
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
  await mkdir(resolve(directory, 'files'));
  const files: Manifest['files'] = [];
  const changedEvidence: string[] = [];
  let total = 0;
  for (const path of [...paths].sort()) {
    const bytes = await readContextFile(root, path);
    total += bytes.length;
    if (total > MAX_BYTES) throw new Error('SESSION_CONTEXT_TRANSFER_LIMIT');
    const sha256 = contextSha256(bytes);
    const expected = proofs.get(path);
    if (expected && [...expected].some((value) => value !== sha256)) changedEvidence.push(path);
    await writeNew(resolve(directory, 'files'), path, bytes);
    files.push({ path, role: roleFor(path), bytes: bytes.length, sha256 });
  }
  if (JSON.stringify(await readSessionState(root)) !== JSON.stringify(state))
    throw new Error('SESSION_CONTEXT_TRANSFER_SOURCE_CHANGED');
  for (const file of files)
    if (contextSha256(await readContextFile(root, file.path)) !== file.sha256)
      throw new Error('SESSION_CONTEXT_TRANSFER_SOURCE_CHANGED');
  const manifest = parseContext(manifestSchema, {
    version: 1,
    kind: 'listingstudio-private-session-context',
    bundleId: randomUUID(),
    createdAt: new Date().toISOString(),
    revision: state.revision,
    files,
    omittedEvidence,
    changedEvidence,
  });
  await writeNew(directory, 'manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  await verifySessionContextBundle(directory);
  return { directory, manifest };
}
export async function verifySessionContextBundle(
  directory: string,
): Promise<{ manifest: Manifest; manifestSha256: string }> {
  const raw = await readContextFile(directory, 'manifest.json', false, 2 * 1024 * 1024);
  const manifest = parseContext(manifestSchema, decode(raw));
  const expected = ['manifest.json', ...manifest.files.map((file) => 'files/' + file.path)].sort();
  if (JSON.stringify(await inventory(directory)) !== JSON.stringify(expected))
    throw new Error('SESSION_CONTEXT_TRANSFER_INVENTORY_MISMATCH');
  for (const file of manifest.files) {
    if (roleFor(file.path) !== file.role) throw new Error('SESSION_CONTEXT_TRANSFER_ROLE_MISMATCH');
    const bytes = await readContextFile(directory, 'files/' + file.path);
    if (bytes.length !== file.bytes || contextSha256(bytes) !== file.sha256)
      throw new Error('SESSION_CONTEXT_TRANSFER_HASH_MISMATCH');
  }
  const state = parseContext(
    sessionStateSchema,
    decode(await readContextFile(directory, 'files/' + STATE)),
  );
  if (
    state.revision !== manifest.revision ||
    manifest.files.filter((file) => file.role === 'state').length !== 1 ||
    manifest.files.filter((file) => file.role === 'journal').length !== state.revision
  )
    throw new Error('SESSION_CONTEXT_TRANSFER_STATE_MISMATCH');
  for (let revision = 1; revision <= state.revision; revision++)
    if (
      !manifest.files.some(
        (file) => file.path === STORE + 'journal/' + String(revision).padStart(8, '0') + '.json',
      )
    )
      throw new Error('SESSION_CONTEXT_TRANSFER_STATE_MISMATCH');
  await readSessionState(resolve(directory, 'files'));
  await allEvidence(resolve(directory, 'files'), state.revision);
  return { manifest, manifestSha256: contextSha256(raw) };
}
export async function planSessionContextImport(
  root: string,
  directory: string,
): Promise<{
  manifest: Manifest;
  manifestSha256: string;
  missingPaths: string[];
  matchingPaths: string[];
}> {
  const verified = await verifySessionContextBundle(directory);
  const missingPaths: string[] = [];
  const matchingPaths: string[] = [];
  for (const file of verified.manifest.files) {
    if (await exists(root, file.path)) {
      if (contextSha256(await readContextFile(root, file.path)) !== file.sha256)
        throw new Error('SESSION_CONTEXT_TRANSFER_TARGET_CONFLICT');
      matchingPaths.push(file.path);
    } else missingPaths.push(file.path);
  }
  if (await exists(root, STORE + 'journal')) {
    const allowed = new Set(
      verified.manifest.files.filter((file) => file.role === 'journal').map((file) => file.path),
    );
    for (const path of await inventory(root, STORE + 'journal'))
      if (!allowed.has(path)) throw new Error('SESSION_CONTEXT_TRANSFER_TARGET_HAS_HISTORY');
  }
  return { ...verified, missingPaths, matchingPaths };
}
export async function importSessionContext(
  root: string,
  directory: string,
): Promise<{
  revision: number;
  copiedFiles: number;
  existingMatches: number;
  omittedEvidence: number;
  changedEvidence: number;
  receiptPath: string;
  remoteActions: false;
}> {
  await planSessionContextImport(root, directory);
  return withContextStoreLock(root, async () => {
    const plan = await planSessionContextImport(root, directory);
    const filesRoot = resolve(directory, 'files');
    let copiedFiles = 0;
    for (const file of plan.manifest.files.filter((file) => file.role !== 'state')) {
      if (!plan.missingPaths.includes(file.path)) continue;
      const bytes = await readContextFile(filesRoot, file.path);
      if (contextSha256(bytes) !== file.sha256)
        throw new Error('SESSION_CONTEXT_TRANSFER_SOURCE_CHANGED');
      await writeNew(root, file.path, bytes);
      copiedFiles++;
    }
    if (plan.missingPaths.includes(STATE)) {
      const entry = plan.manifest.files.find((file) => file.path === STATE)!;
      const bytes = await readContextFile(filesRoot, STATE);
      if (contextSha256(bytes) !== entry.sha256)
        throw new Error('SESSION_CONTEXT_TRANSFER_SOURCE_CHANGED');
      const temp = STORE + 'import-state-' + randomUUID() + '.tmp';
      await writeNew(root, temp, bytes);
      try {
        if (await exists(root, STATE)) throw new Error('SESSION_CONTEXT_TRANSFER_TARGET_CONFLICT');
        await rename(await checkedContextPath(root, temp), await checkedContextPath(root, STATE));
        copiedFiles++;
      } finally {
        await unlink(await checkedContextPath(root, temp)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
    }
    const state = await readSessionState(root);
    if (state.revision !== plan.manifest.revision)
      throw new Error('SESSION_CONTEXT_TRANSFER_STATE_MISMATCH');
    const receiptPath = '.local/onboarding/context-import-' + randomUUID() + '.json';
    await writeNew(
      root,
      receiptPath,
      Buffer.from(
        JSON.stringify(
          {
            version: 1,
            importedAt: new Date().toISOString(),
            bundleId: plan.manifest.bundleId,
            manifestSha256: plan.manifestSha256,
            revision: state.revision,
            copiedFiles,
            existingMatches: plan.matchingPaths.length,
            omittedEvidence: plan.manifest.omittedEvidence,
            changedEvidence: plan.manifest.changedEvidence,
            sourceCodeVerified: false,
            remoteActions: false,
            databaseModified: false,
            batchesResumed: false,
          },
          null,
          2,
        ) + '\n',
      ),
    );
    return {
      revision: state.revision,
      copiedFiles,
      existingMatches: plan.matchingPaths.length,
      omittedEvidence: plan.manifest.omittedEvidence.length,
      changedEvidence: plan.manifest.changedEvidence.length,
      receiptPath,
      remoteActions: false,
    };
  });
}
