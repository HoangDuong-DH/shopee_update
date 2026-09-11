import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, type ChangePlan, type Scope } from '@shopee/domain';
import { Repository, transaction } from '@shopee/persistence';
import {
  InvestigationHarness,
  Deadline,
  sameScope,
  safeHarnessCode,
  validateCitations,
  type KnowledgeLibrary,
  type KnowledgeHit,
} from '@shopee/agent-runtime';

export type KnowledgePort = Pick<KnowledgeLibrary, 'search' | 'readDocument'>;
const requestSchema = z
  .object({
    requestId: z.string().uuid(),
    planId: z.string().uuid(),
    revision: z.number().int().positive(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    query: z.string().trim().max(300).default(''),
  })
  .strict();
export class AssistantService {
  constructor(
    private readonly repo: Repository,
    readonly knowledge: KnowledgePort,
    private readonly options: { timeoutMs?: number } = {},
  ) {}
  private async assertCurrent(plan: ChangePlan, deadline: Deadline) {
    const current = await deadline.wait(() => this.repo.getPlan(plan.id));
    const product = await deadline.wait(() => this.repo.getProduct(plan.productKey));
    const row = (
      await deadline.wait(() =>
        this.repo.pool.query(
          'SELECT environment,partner_id,shop_id,revision,capability_revision FROM connections WHERE environment=$1 AND partner_id=$2 AND shop_id=$3',
          [plan.scope.environment, plan.scope.partnerId, plan.scope.shopId],
        ),
      )
    ).rows[0];
    const scope: Scope | undefined = row && {
      environment: row.environment,
      partnerId: row.partner_id,
      shopId: row.shop_id,
      connectionRevision: row.revision,
      capabilityRevision: row.capability_revision,
    };
    if (
      !current ||
      current.revision !== plan.revision ||
      current.fingerprint !== plan.fingerprint ||
      product?.revision !== plan.sourceRevision ||
      !scope ||
      !sameScope(scope, plan.scope)
    )
      throw new Error('PLAN_CONTEXT_CHANGED');
  }
  private project(row: any) {
    return {
      id: row.id,
      planId: row.plan_id,
      planRevision: row.plan_revision,
      scope: row.scope,
      query: row.query,
      state: row.state === 'running' && row.expired ? 'interrupted' : row.state,
      code: row.code,
      events: row.events,
      result: row.result,
      createdAt: row.created_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
    };
  }
  async list() {
    return (
      await this.repo.pool.query(
        'SELECT id,plan_id,plan_revision,scope,query,state,code,events,result,created_at,deadline_at,finished_at,deadline_at<=clock_timestamp() AS expired FROM assistant_reviews ORDER BY created_at DESC LIMIT 50',
      )
    ).rows.map((row) => this.project(row));
  }
  async get(id: string, deadline = new Deadline()) {
    const row = (
      await deadline.wait(() =>
        this.repo.pool.query(
          'SELECT id,plan_id,plan_revision,scope,query,state,code,events,result,created_at,deadline_at,finished_at,deadline_at<=clock_timestamp() AS expired FROM assistant_reviews WHERE id=$1',
          [id],
        ),
      )
    ).rows[0];
    if (!row) throw new Error('NOT_FOUND');
    return this.project(row);
  }
  async review(raw: unknown) {
    const deadline = new Deadline(this.options.timeoutMs);
    return deadline.wait(() => this.performReview(raw, deadline));
  }
  private async performReview(raw: unknown, deadline: Deadline) {
    const query = (text: string, values: unknown[] = []) =>
      deadline.wait(() => this.repo.pool.query(text, values));
    const input = requestSchema.parse(raw);
    const requestHash = createHash('sha256').update(canonicalJson(input)).digest('hex');
    const previous = (
      await query('SELECT id,request_hash FROM assistant_reviews WHERE request_id=$1', [
        input.requestId,
      ])
    ).rows[0];
    if (previous) {
      if (previous.request_hash !== requestHash) throw new Error('PLAN_REVIEW_REQUEST_CONFLICT');
      return this.get(previous.id, deadline);
    }
    const plan = await deadline.wait(() => this.repo.getPlan(input.planId, input.revision));
    if (!plan || plan.fingerprint !== input.fingerprint) throw new Error('PLAN_CONTEXT_CHANGED');
    await this.assertCurrent(plan, deadline);
    const id = randomUUID();
    const inserted = await query(
      "INSERT INTO assistant_reviews(id,request_id,request_hash,plan_id,plan_revision,scope,query,state,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7,'running',clock_timestamp()+($8::integer*interval '1 millisecond')) ON CONFLICT(request_id) DO NOTHING RETURNING id",
      [
        id,
        input.requestId,
        requestHash,
        plan.id,
        plan.revision,
        plan.scope,
        input.query,
        deadline.remainingMs(),
      ],
    );
    if (!inserted.rowCount) {
      const winner = (
        await query('SELECT id,request_hash FROM assistant_reviews WHERE request_id=$1', [
          input.requestId,
        ])
      ).rows[0];
      if (winner.request_hash !== requestHash) throw new Error('PLAN_REVIEW_REQUEST_CONFLICT');
      return this.get(winner.id, deadline);
    }
    const harness = new InvestigationHarness({
      plan,
      knowledge: this.knowledge,
      assertCurrent: () => this.assertCurrent(plan, deadline),
      trace: async (event) => {
        await query(
          "UPDATE assistant_reviews SET events=events||$2::jsonb WHERE id=$1 AND state='running' AND deadline_at>now()",
          [id, JSON.stringify([event])],
        );
      },
    });
    try {
      const inspection = await harness.call('inspect_plan', {});
      let hits: KnowledgeHit[] = [];
      let issues: string[] = [];
      if (input.query) {
        const search = (await harness.call('search_knowledge', { query: input.query })) as {
          hits: KnowledgeHit[];
          issues: string[];
        };
        hits = search.hits;
        issues = search.issues;
        for (const hit of hits.slice(0, 3))
          await harness.call('read_source', { documentId: hit.id });
      }
      const sources = harness.sources;
      validateCitations(sources, harness.sources);
      await this.assertCurrent(plan, deadline);
      const result = {
        mode: 'deterministic_review',
        inspection,
        hits,
        sources,
        issues,
        note: 'Đối chiếu dữ liệu nội bộ và tìm tài liệu tham khảo. Chưa kết luận chính sách còn hiệu lực/áp dụng cho shop, chưa kiểm duyệt Shopee và chưa gửi đăng. Model AI chưa cấu hình.',
      };
      await this.complete(id, result, deadline);
    } catch (error) {
      if (safeHarnessCode(error) === 'DEADLINE_EXCEEDED') throw error;
      await query(
        "UPDATE assistant_reviews SET state='stopped',code=$2,finished_at=now(),result=$3 WHERE id=$1 AND state='running'",
        [
          id,
          safeHarnessCode(error),
          {
            mode: 'deterministic_review',
            sources: harness.sources,
            note: 'Lần kiểm tra chưa hoàn tất. Giữ nguyên listing và nguồn; đối chiếu lỗi trước khi chạy lại.',
          },
        ],
      );
    }
    return this.get(id, deadline);
  }
  private async complete(id: string, result: unknown, deadline: Deadline) {
    try {
      await deadline.wait(() =>
        transaction(this.repo.pool, async (client) => {
          // The row is locked before the deadline is checked. A JS timeout alone
          // cannot cancel a PostgreSQL UPDATE waiting behind another transaction.
          await client.query("SELECT set_config('statement_timeout',$1,true)", [
            String(deadline.remainingMs()),
          ]);
          await client.query('SELECT id FROM assistant_reviews WHERE id=$1 FOR UPDATE', [id]);
          await client.query("SELECT set_config('statement_timeout',$1,true)", [
            String(deadline.remainingMs()),
          ]);
          const updated = await client.query(
            "UPDATE assistant_reviews SET state='completed',result=$2,finished_at=clock_timestamp() WHERE id=$1 AND state='running' AND deadline_at>clock_timestamp()",
            [id, result],
          );
          if (!updated.rowCount) throw new Error('DEADLINE_EXCEEDED');
          deadline.remainingMs();
        }),
      );
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '57014')
        throw new Error('DEADLINE_EXCEEDED');
      throw error;
    }
  }
}
