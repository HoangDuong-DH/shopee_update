import { describe, it, expect } from 'vitest';
import {
  applySessionCheckpoint,
  emptySessionState,
  parseContext,
  sessionTaskPatchSchema,
  contextFeatureRegistrySchema,
  selectContextDocuments,
  renderSessionContext,
  contextSha256,
  containsContextSecret,
  isContextPath,
  selectSessionTasks,
  type ContextFeatureRegistry,
} from '../../packages/agent-runtime/src/session-context.js';
const registry: ContextFeatureRegistry = {
  version: 1,
  projectId: 'listing-studio',
  coreDocuments: ['AGENTS.md'],
  features: [
    {
      id: 'base',
      title: 'Base',
      document: 'docs/base.md',
      code: ['src/base.ts'],
      tests: [],
      relatedDocuments: [],
      dependsOn: [],
    },
    {
      id: 'next',
      title: 'Next',
      document: 'docs/next.md',
      code: [],
      tests: [],
      relatedDocuments: [],
      dependsOn: ['base'],
    },
    {
      id: 'other',
      title: 'Other',
      document: 'docs/other.md',
      code: [],
      tests: [],
      relatedDocuments: [],
      dependsOn: [],
    },
  ],
};
const patch = (overrides: Record<string, unknown> = {}) =>
  parseContext(sessionTaskPatchSchema, {
    id: 'job',
    title: 'Công việc',
    featureIds: ['base'],
    status: 'active',
    goal: 'Kiểm tra cơ chế',
    scope: { description: 'Chỉ local' },
    ...overrides,
  });
const checkpoint = (state = emptySessionState(), overrides: Record<string, unknown> = {}) =>
  applySessionCheckpoint({
    state,
    patch: patch(overrides),
    expectedRevision: state.revision,
    now: '2026-10-05T00:00:00.000Z',
    repository: { head: 'a'.repeat(40), featureFingerprint: contextSha256('code') },
    evidence: [],
  });

describe('session context contract', () => {
  it('routes only selected feature and dependencies without loading unrelated documents', () => {
    expect(selectContextDocuments(registry, ['next']).documents).toEqual([
      'AGENTS.md',
      'docs/base.md',
      'docs/next.md',
    ]);
    expect(() => selectContextDocuments(registry, ['missing'])).toThrow('UNKNOWN_FEATURE');
  });
  it('rejects cycles, duplicate feature IDs and unknown dependencies', () => {
    const cycle = structuredClone(registry);
    cycle.features[0].dependsOn = ['next'];
    expect(contextFeatureRegistrySchema.safeParse(cycle).success).toBe(false);
    const duplicate = structuredClone(registry);
    duplicate.features.push(duplicate.features[0]);
    expect(contextFeatureRegistrySchema.safeParse(duplicate).success).toBe(false);
    const missing = structuredClone(registry);
    missing.features[0].dependsOn = ['missing'];
    expect(contextFeatureRegistrySchema.safeParse(missing).success).toBe(false);
  });
  it('rejects secret-like values and undeclared fields, without printing their contents', () => {
    expect(() => patch({ observations: ['access_token=' + 'x'.repeat(40)] })).toThrow(
      'INVALID_OR_SECRET',
    );
    expect(() => patch({ authority: 'write_everything' })).toThrow('INVALID_OR_SECRET');
    expect(containsContextSecret('Bearer ' + 'x'.repeat(30))).toBe(true);
    expect(containsContextSecret('https://user:password@example.invalid')).toBe(true);
    expect(containsContextSecret('Tồn 1000, giá 179999')).toBe(false);
  });
  it.each([
    '../secret.json',
    'C:/secret.json',
    '.env',
    'docs/../../secret.md',
    '.git/config',
    'node_modules/file',
    'private/app-key.json',
    'a\\b',
    'docs/NUL.md',
    'docs/name. ',
    'docs/question?.md',
    'docs/file:stream',
    'secret.json',
    'original-envs.txt',
  ])('rejects unsafe path %s', (value) => {
    expect(isContextPath(value)).toBe(false);
  });
  it('does not allow private source material in public feature documents', () => {
    const value = structuredClone(registry);
    value.features[0].document = '.local/history.md';
    expect(contextFeatureRegistrySchema.safeParse(value).success).toBe(false);
    expect(isContextPath('.local/receipt.json')).toBe(true);
  });
  it('preserves user decisions and do-not-replay constraints across checkpoints', () => {
    const first = checkpoint(undefined, {
      decisions: ['Chỉ đăng ẩn'],
      doNotReplay: ['Không retry unknown'],
    });
    const next = checkpoint(first, { decisions: ['Đúng shop đã chọn'] });
    expect(next.tasks[0].decisions).toEqual(['Chỉ đăng ẩn', 'Đúng shop đã chọn']);
    expect(next.tasks[0].doNotReplay).toEqual(['Không retry unknown']);
  });
  it('preserves paused state until a recorded resume decision, without granting capabilities', () => {
    const first = checkpoint(undefined, { status: 'paused' });
    expect(() => checkpoint(first)).toThrow('RESUME_DECISION_REQUIRED');
    const next = checkpoint(first, {
      resumeDecision: 'Người dùng yêu cầu tiếp tục đúng phạm vi local',
    });
    expect(next.tasks[0].status).toBe('active');
    expect('canWriteShopee' in next.tasks[0]).toBe(false);
  });
  it('does not silently remove unresolved questions or finish without evidence', () => {
    const first = checkpoint(undefined, { openQuestions: ['Nguồn nào?'] });
    expect(checkpoint(first).tasks[0].openQuestions).toEqual(['Nguồn nào?']);
    expect(() => checkpoint(first, { status: 'done' })).toThrow('COMPLETION_EVIDENCE_REQUIRED');
    expect(checkpoint(first, { resolvedQuestions: ['Nguồn nào?'] }).tasks[0].openQuestions).toEqual(
      [],
    );
    expect(() => checkpoint(undefined, { status: 'done' })).toThrow('COMPLETION_EVIDENCE_REQUIRED');
  });
  it('detects optimistic revision conflicts instead of overwriting state', () => {
    const state = checkpoint();
    expect(() =>
      applySessionCheckpoint({
        state,
        patch: patch(),
        expectedRevision: 0,
        now: state.updatedAt,
        repository: state.tasks[0].repository,
        evidence: [],
      }),
    ).toThrow('REVISION_CONFLICT');
  });
  it('keeps paused tasks visible even when the active feature differs', () => {
    const paused = checkpoint(undefined, { status: 'paused', doNotReplay: ['Không chạy batch'] });
    const state = checkpoint(paused, { id: 'second', featureIds: ['other'] });
    const result = renderSessionContext({
      state,
      registry,
      featureIds: ['other'],
      documents: [
        { path: 'AGENTS.md', content: 'Rules' },
        { path: 'docs/other.md', content: 'Other' },
      ],
      freshness: [],
    });
    expect(result.text).toContain('Không chạy batch');
    expect(result.text).toContain('notLoadedTaskIds');
    expect(result.text).not.toContain('## docs/base.md');
    expect(result.bytes).toBe(Buffer.byteLength(result.text));
  });
  it('selects the focused task while retaining an index to other task checkpoints', () => {
    const first = checkpoint();
    const state = checkpoint(first, { id: 'second', decisions: ['Current decision'] });
    expect(selectSessionTasks(state, ['base']).map((task) => task.id)).toEqual(['second']);
    expect(selectSessionTasks(state, ['base'], 'job').map((task) => task.id)).toEqual(['job']);
    const output = renderSessionContext({
      state,
      registry,
      featureIds: ['base'],
      documents: [
        { path: 'AGENTS.md', content: 'Rules' },
        { path: 'docs/base.md', content: 'Base' },
      ],
      freshness: [],
    });
    expect(output.text).toContain('Current decision');
    expect(output.text).toContain('"notLoadedTaskIds": [\n    "job"');
    expect(() => selectSessionTasks(state, ['base'], 'missing')).toThrow('UNKNOWN_TASK');
  });
  it('loads ongoing matching tasks or only the latest completed task when focus is elsewhere', () => {
    const state = checkpoint(checkpoint(), { id: 'other-job', featureIds: ['other'] });
    expect(selectSessionTasks(state, ['base']).map((task) => task.id)).toEqual(['job']);
    const complete = structuredClone(state);
    complete.tasks[0].status = 'done';
    complete.tasks.push({
      ...complete.tasks[0],
      id: 'newer',
      updatedAt: '2026-10-05T01:00:00.000Z',
    });
    expect(selectSessionTasks(complete, ['base']).map((task) => task.id)).toEqual(['newer']);
    expect(complete.tasks).toHaveLength(3);
    expect(selectSessionTasks(complete, ['next'])).toEqual([]);
  });
  it('fails safely on budget overflow and missing selected documents', () => {
    const input = {
      state: emptySessionState(),
      registry,
      featureIds: ['base'],
      freshness: [],
      documents: [
        { path: 'AGENTS.md', content: 'x'.repeat(6000) },
        { path: 'docs/base.md', content: 'Base' },
      ],
    };
    expect(() => renderSessionContext({ ...input, maxBytes: 4096 })).toThrow('BUDGET_EXCEEDED');
    expect(() => renderSessionContext({ ...input, documents: [] })).toThrow('DOCUMENT_MISSING');
  });
  it('does not emit credentials from public documents or unsupported memory claims', () => {
    const input = {
      state: emptySessionState(),
      registry,
      featureIds: ['base'],
      freshness: [],
      documents: [
        { path: 'AGENTS.md', content: 'password=' + 'x'.repeat(20) },
        { path: 'docs/base.md', content: 'Base' },
      ],
    };
    expect(() => renderSessionContext(input)).toThrow('SECRET_BLOCKED');
    const output = renderSessionContext({
      ...input,
      documents: input.documents.map((entry) => ({ ...entry, content: 'Safe' })),
    });
    expect(output.text).toContain('CHƯA CÓ CHECKPOINT');
    expect(output.text).toContain('không xóa lịch sử chat');
  });
});
