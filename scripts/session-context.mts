import {
  exportSessionContext,
  verifySessionContextBundle,
  planSessionContextImport,
  importSessionContext,
} from '../packages/agent-runtime/src/session-transfer.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONTEXT_BYTES,
  renderSessionContext,
  selectContextDocuments,
  selectSessionTasks,
  containsContextSecret,
} from '../packages/agent-runtime/src/session-context.js';
import {
  loadContextRegistry,
  readSessionState,
  inspectContextFreshness,
  readContextFile,
  checkpointSession,
  readSessionPatch,
  recoverSession,
  readContextHistory,
  readContextChanges,
  releaseAbandonedContextLock,
} from '../packages/agent-runtime/src/session-store.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const command = args.shift() ?? 'brief';
function options(allowed: string[]): Map<string, string> {
  const result = new Map<string, string>();
  while (args.length) {
    const key = args.shift()!;
    if (!allowed.includes(key) || result.has(key))
      throw new Error('SESSION_CONTEXT_ARGUMENT_INVALID');
    if (['--runtime', '--apply'].includes(key)) {
      result.set(key, 'true');
      continue;
    }
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error('SESSION_CONTEXT_ARGUMENT_INVALID');
    result.set(key, value);
  }
  return result;
}
function integer(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new Error('SESSION_CONTEXT_ARGUMENT_INVALID');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('SESSION_CONTEXT_ARGUMENT_INVALID');
  return number;
}
async function runtimeObservation(): Promise<unknown> {
  const observedAt = new Date().toISOString();
  try {
    const response = await fetch('http://127.0.0.1:4310/v1/status', {
      signal: AbortSignal.timeout(2500),
      redirect: 'error',
    });
    if (!response.ok || !response.body)
      return { observedAt, api: 'unavailable', currentShopState: 'not_checked' };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const entry = await reader.read();
        if (entry.done) break;
        length += entry.value.length;
        if (length > 64 * 1024) throw new Error('RUNTIME_TOO_LARGE');
        chunks.push(entry.value);
      }
    } finally {
      await reader.cancel();
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    const workflow = value.productionBatchWorkflow as Record<string, unknown> | undefined;
    return {
      observedAt,
      api: 'responding',
      worker: ['online', 'held', 'offline'].includes(String(value.worker))
        ? value.worker
        : 'unknown',
      productionWorkflowEnabled:
        typeof workflow?.enabled === 'boolean' ? workflow.enabled : 'unknown',
      productionWritesConfigured:
        typeof workflow?.productionWritesConfigured === 'boolean'
          ? workflow.productionWritesConfigured
          : 'unknown',
      currentShopState: 'not_checked',
      databaseAcceptance: 'not_checked',
      postingReadiness: 'not_assessed',
    };
  } catch {
    return {
      observedAt,
      api: 'unreachable_or_invalid',
      currentShopState: 'not_checked',
      postingReadiness: 'not_assessed',
    };
  }
}
function print(value: unknown): void {
  const output = JSON.stringify(value, null, 2);
  if (containsContextSecret(output)) throw new Error('SESSION_CONTEXT_SECRET_BLOCKED');
  if (Buffer.byteLength(output, 'utf8') > DEFAULT_CONTEXT_BYTES)
    throw new Error('SESSION_CONTEXT_BUDGET_EXCEEDED');
  console.log(output);
}
async function main(): Promise<void> {
  if (command === 'help') {
    if (args.length) throw new Error('SESSION_CONTEXT_ARGUMENT_INVALID');
    console.log(
      'brief [--feature id,id] [--task id] [--max-bytes 32768] [--runtime]\nstatus\nverify [--task id]\ncheckpoint --input .local/<patch>.json --expected-revision N\nhistory --task id [--limit 5]\nchanges --since-revision N [--limit 5]\nrecover --expected-revision N\nunlock --expected-owner-pid N\nexport --output .local/context-handoff\nverify-bundle --bundle DIR\nimport --bundle DIR [--apply]\nGuide: docs/ai/SESSION_CONTINUITY.md',
    );
    return;
  }
  if (command === 'export') {
    const opts = options(['--output']);
    const value = await exportSessionContext(root, opts.get('--output') ?? '');
    print({
      directory: value.directory,
      revision: value.manifest.revision,
      files: value.manifest.files.length,
      omittedEvidence: value.manifest.omittedEvidence.length,
      changedEvidence: value.manifest.changedEvidence.length,
      privateContextOnly: true,
      remoteActions: false,
    });
    return;
  }
  if (command === 'verify-bundle') {
    const opts = options(['--bundle']);
    if (!opts.get('--bundle')) throw new Error('SESSION_CONTEXT_ARGUMENT_INVALID');
    const value = await verifySessionContextBundle(resolve(root, opts.get('--bundle')!));
    print({
      revision: value.manifest.revision,
      files: value.manifest.files.length,
      manifestSha256: value.manifestSha256,
      omittedEvidence: value.manifest.omittedEvidence.length,
      changedEvidence: value.manifest.changedEvidence.length,
      remoteActions: false,
    });
    return;
  }
  if (command === 'import') {
    const opts = options(['--bundle', '--apply']);
    if (!opts.get('--bundle')) throw new Error('SESSION_CONTEXT_ARGUMENT_INVALID');
    const directory = resolve(root, opts.get('--bundle')!);
    if (opts.has('--apply')) print(await importSessionContext(root, directory));
    else {
      const plan = await planSessionContextImport(root, directory);
      print({
        apply: false,
        revision: plan.manifest.revision,
        copyFiles: plan.missingPaths.length,
        existingMatches: plan.matchingPaths.length,
        omittedEvidence: plan.manifest.omittedEvidence.length,
        changedEvidence: plan.manifest.changedEvidence.length,
        remoteActions: false,
      });
    }
    return;
  }
  if (command === 'checkpoint') {
    const opts = options(['--input', '--expected-revision']);
    if (!opts.get('--input')) throw new Error('SESSION_CONTEXT_ARGUMENT_INVALID');
    const state = await checkpointSession(
      root,
      await readSessionPatch(root, opts.get('--input')!),
      integer(opts.get('--expected-revision')),
    );
    print({
      revision: state.revision,
      taskId: state.focusTaskId,
      statePath: '.local/session-context/state.json',
      remoteActions: false,
    });
    return;
  }
  if (command === 'recover') {
    const opts = options(['--expected-revision']);
    const state = await recoverSession(root, integer(opts.get('--expected-revision')));
    print({ revision: state.revision, recoveredLocalCheckpoint: true, remoteActions: false });
    return;
  }
  if (command === 'unlock') {
    const opts = options(['--expected-owner-pid']);
    await releaseAbandonedContextLock(root, integer(opts.get('--expected-owner-pid')));
    print({ releasedAbandonedLocalLock: true, remoteActions: false });
    return;
  }
  if (command === 'history') {
    const opts = options(['--task', '--limit']);
    print(
      await readContextHistory(
        root,
        opts.get('--task') ?? '',
        opts.has('--limit') ? integer(opts.get('--limit')) : 5,
      ),
    );
    return;
  }
  if (command === 'changes') {
    const opts = options(['--since-revision', '--limit']);
    const changes = await readContextChanges(
      root,
      integer(opts.get('--since-revision')),
      opts.has('--limit') ? integer(opts.get('--limit')) : 5,
    );
    const state = await readSessionState(root);
    const registry = await loadContextRegistry(root);
    const packet = {
      ...changes,
      freshness: await inspectContextFreshness(root, registry, state.tasks),
      remoteActions: false,
    };
    if (Buffer.byteLength(JSON.stringify(packet), 'utf8') > DEFAULT_CONTEXT_BYTES)
      throw new Error('SESSION_CONTEXT_BUDGET_EXCEEDED');
    print(packet);
    return;
  }
  const opts = options(
    command === 'brief'
      ? ['--feature', '--task', '--max-bytes', '--runtime']
      : command === 'verify'
        ? ['--task']
        : [],
  );
  if (!['brief', 'status', 'verify'].includes(command))
    throw new Error('SESSION_CONTEXT_ARGUMENT_INVALID');
  const state = await readSessionState(root);
  const registry = await loadContextRegistry(root);
  if (command === 'status') {
    print({
      revision: state.revision,
      updatedAt: state.updatedAt,
      focusTaskId: state.focusTaskId,
      features: registry.features.map(({ id, title }) => ({ id, title })),
      tasks: state.tasks.map(({ id, title, status, featureIds }) => ({
        id,
        title,
        status,
        featureIds,
      })),
      remoteActions: false,
    });
    return;
  }
  const taskId = opts.get('--task');
  if (taskId && !state.tasks.some((task) => task.id === taskId))
    throw new Error('SESSION_CONTEXT_UNKNOWN_TASK');
  const tasks = taskId ? state.tasks.filter((task) => task.id === taskId) : state.tasks;
  if (command === 'verify') {
    const freshness = await inspectContextFreshness(root, registry, tasks);
    print({
      revision: state.revision,
      freshness,
      evidenceMeaning:
        'Hash khớp chỉ chứng minh tệp không đổi, không chứng minh dữ liệu đúng hoặc Shopee hiện tại đã khớp.',
    });
    if (
      freshness.some(
        (entry) =>
          entry.headChanged ||
          entry.featureChanged ||
          entry.repositoryChanged !== false ||
          entry.evidence.some((proof) => proof.status !== 'matches'),
      )
    )
      process.exitCode = 2;
    return;
  }
  const focused = state.tasks.find((task) => task.id === (taskId ?? state.focusTaskId));
  const featureIds = opts.get('--feature')?.split(',') ??
    focused?.featureIds ?? ['session-continuity'];
  const selection = selectContextDocuments(registry, featureIds);
  const selectedTasks = selectSessionTasks(state, featureIds, taskId);
  const documents = [];
  for (const path of selection.documents)
    documents.push({
      path,
      content: (await readContextFile(root, path, true, 32 * 1024))
        .toString('utf8')
        .replace(/^\uFEFF/, ''),
    });
  const output = renderSessionContext({
    state,
    registry,
    featureIds,
    taskId,
    documents,
    freshness: await inspectContextFreshness(root, registry, selectedTasks),
    maxBytes: opts.has('--max-bytes') ? integer(opts.get('--max-bytes')) : DEFAULT_CONTEXT_BYTES,
    ...(opts.has('--runtime') ? { runtime: await runtimeObservation() } : {}),
  });
  console.log(output.text);
  console.error(
    `SESSION_CONTEXT_PACKET_BYTES=${output.bytes}; LIMIT=${opts.get('--max-bytes') ?? DEFAULT_CONTEXT_BYTES}`,
  );
}
main().catch((error) => {
  const message =
    error instanceof Error && /^SESSION_CONTEXT_[A-Z_]+$/.test(error.message)
      ? error.message
      : 'SESSION_CONTEXT_IO_OR_CONFIGURATION_ERROR';
  console.error(
    `${message}: xem docs/ai/SESSION_CONTINUITY.md; không tự reset trạng thái hoặc chạy lại thao tác Shopee.`,
  );
  process.exitCode = 1;
});
