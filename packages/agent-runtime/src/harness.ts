import { canonicalJson, validateDraft, type ChangePlan, type Scope } from '@shopee/domain';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { KnowledgeLibrary, KnowledgeSource } from './retrieval.js';

export type TraceEvent = {
  tool: string;
  phase: 'started' | 'completed' | 'stopped';
  code: string;
  elapsedMs: number;
};
export type HarnessContext = {
  plan: ChangePlan;
  knowledge: Pick<KnowledgeLibrary, 'search' | 'readDocument'>;
  assertCurrent: () => Promise<void>;
  trace: (event: TraceEvent) => Promise<void>;
};
export type HarnessOptions = { maxCalls?: number; timeoutMs?: number };
export function sameScope(a: Scope, b: Scope): boolean {
  return (
    a.environment === b.environment &&
    a.partnerId === b.partnerId &&
    a.shopId === b.shopId &&
    a.connectionRevision === b.connectionRevision &&
    a.capabilityRevision === b.capabilityRevision
  );
}
export function validateCitations(
  citations: { id: string; sha256: string }[],
  read: KnowledgeSource[],
): void {
  if (citations.some((c) => !read.some((r) => r.id === c.id && r.sha256 === c.sha256)))
    throw new Error('CITATION_NOT_READ');
}
const schemas = {
  inspect_plan: z.object({}).strict(),
  search_knowledge: z.object({ query: z.string().trim().min(1).max(300) }).strict(),
  read_source: z.object({ documentId: z.string().min(1).max(300) }).strict(),
};
const safeCodes = new Set([
  'TOOL_NOT_ALLOWED',
  'TOOL_INPUT_INVALID',
  'TOOL_REPEAT',
  'CALL_BUDGET_EXCEEDED',
  'DEADLINE_EXCEEDED',
  'PLAN_CONTEXT_CHANGED',
  'HARNESS_STOPPED',
  'TOOL_BUSY',
  'CITATION_NOT_READ',
  'KNOWLEDGE_UNKNOWN_DOCUMENT',
  'KNOWLEDGE_OPEN_PLATFORM_UNAVAILABLE',
  'KNOWLEDGE_SELLER_VN_UNAVAILABLE',
  'KNOWLEDGE_SOURCE_NOT_ALLOWED',
  'KNOWLEDGE_PATH_OUTSIDE_ROOT',
  'KNOWLEDGE_DOCUMENT_UNAVAILABLE',
  'KNOWLEDGE_DOCUMENT_TOO_LARGE',
  'KNOWLEDGE_INTEGRITY_MISMATCH',
]);
export function safeHarnessCode(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return safeCodes.has(code) ? code : 'TOOL_FAILED';
}
export class InvestigationHarness {
  private readonly started = performance.now();
  private readonly seen = new Set<string>();
  private readonly documents = new Map<string, KnowledgeSource>();
  private readonly maxCalls: number;
  private readonly timeoutMs: number;
  private calls = 0;
  private busy = false;
  private stopped = false;
  constructor(
    private readonly context: HarnessContext,
    options: HarnessOptions = {},
  ) {
    this.maxCalls = options.maxCalls ?? 8;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (
      !Number.isInteger(this.maxCalls) ||
      this.maxCalls < 1 ||
      this.maxCalls > 32 ||
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120_000
    )
      throw new Error('INVALID_HARNESS_BUDGET');
  }
  private async bounded<T>(work: () => Promise<T>): Promise<T> {
    const remaining = this.timeoutMs - (performance.now() - this.started);
    if (remaining <= 0) throw new Error('DEADLINE_EXCEEDED');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('DEADLINE_EXCEEDED')), remaining);
        }),
      ]);
      if (performance.now() - this.started >= this.timeoutMs) throw new Error('DEADLINE_EXCEEDED');
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private event(tool: string, phase: TraceEvent['phase'], code = ''): TraceEvent {
    return { tool, phase, code, elapsedMs: Math.round(performance.now() - this.started) };
  }
  async call(tool: string, input: unknown): Promise<unknown> {
    if (this.busy) throw new Error('TOOL_BUSY');
    if (this.stopped) throw new Error('HARNESS_STOPPED');
    this.busy = true;
    const label = Object.hasOwn(schemas, tool) ? tool : 'unrecognized';
    try {
      if (this.calls >= this.maxCalls) throw new Error('CALL_BUDGET_EXCEEDED');
      this.calls++;
      if (!Object.hasOwn(schemas, tool)) throw new Error('TOOL_NOT_ALLOWED');
      const parsed = schemas[tool as keyof typeof schemas].safeParse(input);
      if (!parsed.success) throw new Error('TOOL_INPUT_INVALID');
      const identity = tool + canonicalJson(parsed.data);
      if (this.seen.has(identity)) throw new Error('TOOL_REPEAT');
      this.seen.add(identity);
      await this.bounded(() => this.context.assertCurrent());
      await this.bounded(() => this.context.trace(this.event(label, 'started')));
      const result = await this.bounded(async () => {
        if (tool === 'search_knowledge')
          return this.context.knowledge.search((parsed.data as { query: string }).query, 5);
        if (tool === 'read_source')
          return this.context.knowledge.readDocument(
            (parsed.data as { documentId: string }).documentId,
          );
        const plan = this.context.plan;
        const issues = [...plan.issues, ...validateDraft(plan.desired)];
        return structuredClone({
          planId: plan.id,
          revision: plan.revision,
          fingerprint: plan.fingerprint,
          scope: plan.scope,
          sourceRevision: plan.sourceRevision,
          issues: issues.filter(
            (issue, index) =>
              issues.findIndex((i) => i.code === issue.code && i.field === issue.field) === index,
          ),
          listingExecution: 'not_verified',
          qc: 'not_verified',
          fieldCoverage: 'foundation_only',
        });
      });
      await this.bounded(() => this.context.assertCurrent());
      if (tool === 'read_source') {
        const source = (result as { source: KnowledgeSource }).source;
        if (source.id !== (parsed.data as { documentId: string }).documentId)
          throw new Error('CITATION_NOT_READ');
      }
      await this.bounded(() => this.context.trace(this.event(label, 'completed')));
      if (tool === 'read_source') {
        const source = (result as { source: KnowledgeSource }).source;
        this.documents.set(source.id, structuredClone(source));
      }
      return structuredClone(result);
    } catch (error) {
      this.stopped = true;
      const code = safeHarnessCode(error);
      // The caller durably records final failure too, even when this hook cannot persist.
      await this.bounded(() => this.context.trace(this.event(label, 'stopped', code))).catch(
        () => {},
      );
      throw new Error(code);
    } finally {
      this.busy = false;
    }
  }
  get sources(): KnowledgeSource[] {
    return structuredClone([...this.documents.values()]);
  }
}
