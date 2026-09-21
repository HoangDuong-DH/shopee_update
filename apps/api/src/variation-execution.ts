import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  Repository,
  transaction,
  lockSandboxMutationLane,
  sandboxMutationLaneBusy,
} from '@shopee/persistence';
import { canonicalJson, type Scope } from '@shopee/domain';
import {
  SecretBox,
  SandboxPreparedTransport,
  pollPreparedReadback,
  type PreparedAllowedShop,
  planVariationMutation,
  variationBaselineFingerprint,
  checkVariationMutationStage,
  type FieldSnapshot,
  type VariationMutationIntent,
} from '@shopee/gateway';

export type VariationExecutionInput = {
  id: string;
  connectionId: string;
  scope: Scope;
  intent: VariationMutationIntent;
  context: Parameters<typeof planVariationMutation>[1];
};
const hash = (x: unknown) => createHash('sha256').update(canonicalJson(x)).digest('hex');
const owner = (scope: Scope) => `${scope.environment}:${scope.partnerId}:${scope.shopId}`;
const scopeSchema = z
  .object({
    environment: z.literal('sandbox'),
    partnerId: z.string().regex(/^[1-9]\d*$/),
    shopId: z.string().regex(/^[1-9]\d*$/),
    connectionRevision: z.number().int().positive(),
    capabilityRevision: z.number().int().nonnegative(),
  })
  .strict();

/** Explicit sandbox structural edit. Acknowledgement never advances a stage without independent readback. */
export class VariationExecutionService {
  constructor(
    readonly repo: Repository,
    readonly options: {
      allowedShops: PreparedAllowedShop[];
      encryptionKey?: string;
      transport?: typeof fetch;
      now?: () => Date;
      pause?: (ms: number) => Promise<void>;
      readbackDelaysMs?: number[];
    },
  ) {}
  private now() {
    return this.options.now?.() ?? new Date();
  }
  private validConnection(row: any, input: VariationExecutionInput) {
    if (
      !row ||
      row.environment !== 'sandbox' ||
      row.partner_id !== input.scope.partnerId ||
      row.shop_id !== input.scope.shopId ||
      !this.options.allowedShops.some(
        (s) => s.partnerId === row.partner_id && s.shopId === row.shop_id,
      )
    )
      throw new Error('VARIATION_SCOPE_FORBIDDEN');
    if (
      row.revision !== input.scope.connectionRevision ||
      row.capability_revision !== input.scope.capabilityRevision
    )
      throw new Error('VARIATION_CONNECTION_CHANGED');
    if (
      row.state !== 'connected' ||
      (row.expires_at && new Date(row.expires_at).getTime() <= this.now().getTime())
    )
      throw new Error('VARIATION_AUTH_REQUIRED');
  }
  private async client(input: VariationExecutionInput) {
    const row = (
      await this.repo.pool.query('SELECT * FROM connections WHERE id=$1', [input.connectionId])
    ).rows[0];
    this.validConnection(row, input);
    try {
      const box = new SecretBox(this.options.encryptionKey ?? process.env.APP_ENCRYPTION_KEY ?? '');
      const secrets = z
        .object({ partnerKey: z.string().min(1), accessToken: z.string().min(1) })
        .parse({
          ...(box.open(row.partner_key_ciphertext, owner(input.scope)) as object),
          ...(box.open(row.token_ciphertext, owner(input.scope)) as object),
        });
      return new SandboxPreparedTransport(
        { environment: 'sandbox', partnerId: row.partner_id, shopId: row.shop_id, ...secrets },
        this.options.allowedShops,
        this.options.transport,
      );
    } catch {
      throw new Error('VARIATION_AUTH_REQUIRED');
    }
  }
  async prepare(raw: VariationExecutionInput) {
    const input = structuredClone(raw);
    z.string().uuid().parse(input.id);
    z.string().uuid().parse(input.connectionId);
    scopeSchema.parse(input.scope);
    if (['803934364', '846056124'].includes(input.intent.itemId))
      throw new Error('VARIATION_PROTECTED_ITEM');
    if (
      input.context.scope.environment !== input.scope.environment ||
      input.context.scope.partnerId !== input.scope.partnerId ||
      input.context.scope.shopId !== input.scope.shopId
    )
      throw new Error('VARIATION_SCOPE_FORBIDDEN');
    await this.client(input);
    const plan = planVariationMutation(input.intent, input.context);
    const fingerprint = hash({
      owner: owner(input.scope),
      intent: input.intent,
      context: input.context,
    });
    return transaction(this.repo.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'prepared-wire:' + owner(input.scope),
      ]);
      const old = (
        await c.query(
          'SELECT * FROM variation_operations WHERE id=$1 OR (owner_key=$2 AND fingerprint=$3)',
          [input.id, owner(input.scope), fingerprint],
        )
      ).rows;
      const sameId = old.find((r) => r.id === input.id);
      if (sameId && canonicalJson(sameId.input) !== canonicalJson(input))
        throw new Error('VARIATION_INTENT_CONFLICT');
      if (old.length) return { id: old[0].id, state: old[0].state, plan: old[0].plan };
      const state = plan.kind === 'ready' ? 'prepared' : 'blocked';
      await c.query(
        'INSERT INTO variation_operations(id,connection_id,owner_key,fingerprint,input,plan,state,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          input.id,
          input.connectionId,
          owner(input.scope),
          fingerprint,
          input,
          plan,
          state,
          plan.kind === 'ready' ? null : plan,
        ],
      );
      return { id: input.id, state, plan };
    });
  }
  async get(id: string) {
    z.string().uuid().parse(id);
    const row = (await this.repo.pool.query('SELECT * FROM variation_operations WHERE id=$1', [id]))
      .rows[0];
    if (!row) throw new Error('VARIATION_NOT_FOUND');
    const steps = (
      await this.repo.pool.query(
        'SELECT * FROM variation_steps WHERE operation_id=$1 ORDER BY ordinal',
        [id],
      )
    ).rows;
    return {
      id: row.id,
      state: row.state,
      input: row.input as VariationExecutionInput,
      plan: row.plan as ReturnType<typeof planVariationMutation>,
      result: row.result,
      steps,
    };
  }
  private async read(client: SandboxPreparedTransport, itemId: string, signal?: AbortSignal) {
    const base = await client.read(
      '/api/v2/product/get_item_base_info',
      { item_id_list: itemId, need_tax_info: 'true', need_complaint_policy: 'true' },
      signal,
    );
    if (base.kind !== 'success') return base;
    const items = base.response.item_list;
    if (!Array.isArray(items) || items.length !== 1 || String(items[0]?.item_id) !== itemId)
      return { kind: 'unknown' as const, code: 'VARIATION_INVALID_READBACK' };
    if (items[0].has_model === false)
      return {
        kind: 'success' as const,
        response: { item: items[0], models: { model: [], tier_variation: [] } } as FieldSnapshot,
        requestId: base.requestId,
      };
    if (items[0].has_model !== true)
      return { kind: 'unknown' as const, code: 'VARIATION_INVALID_READBACK' };
    const models = await client.read('/api/v2/product/get_model_list', { item_id: itemId }, signal);
    if (models.kind !== 'success') return models;
    return {
      kind: 'success' as const,
      response: { item: items[0], models: models.response } as FieldSnapshot,
      requestId: base.requestId + ':' + models.requestId,
    };
  }
  async run(id: string) {
    z.string().uuid().parse(id);
    const claim = randomUUID();
    const row = await transaction(this.repo.pool, async (c) => {
      const current = (
        await c.query('SELECT * FROM variation_operations WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (!current) throw new Error('VARIATION_NOT_FOUND');
      if (
        !['prepared', 'running'].includes(current.state) ||
        (current.state === 'running' &&
          new Date(current.lease_until).getTime() > this.now().getTime())
      )
        return null;
      await lockSandboxMutationLane(c, current.owner_key);
      if (await sandboxMutationLaneBusy(c, current.owner_key, { family: 'variation', id }))
        return null;
      if (
        (
          await c.query(
            "SELECT 1 FROM variation_steps WHERE operation_id=$1 AND state<>'verified'",
            [id],
          )
        ).rowCount
      ) {
        await c.query(
          "UPDATE variation_operations SET state='unknown',result=$2,claim_id=NULL,lease_until=NULL WHERE id=$1",
          [id, { code: 'VARIATION_UNRESOLVED_SENT_STAGE' }],
        );
        return null;
      }
      return (
        await c.query(
          "UPDATE variation_operations SET state='running',claim_id=$2,lease_until=$3,updated_at=$4 WHERE id=$1 RETURNING *",
          [id, claim, new Date(this.now().getTime() + 120000), this.now()],
        )
      ).rows[0];
    });
    if (!row) return this.get(id);
    const input: VariationExecutionInput = row.input;
    const plan = row.plan as ReturnType<typeof planVariationMutation>;
    try {
      if (plan.kind !== 'ready') throw new Error('VARIATION_PLAN_BLOCKED');
      for (let index = 0; index < plan.steps.length; index++) {
        const stage = plan.steps[index]!;
        const saved = await this.get(id);
        if (saved.steps.some((s) => s.ordinal === index && s.state === 'verified')) continue;
        const expected =
          index === 0
            ? input.context.baseline
            : saved.steps.find((s) => s.ordinal === index - 1 && s.state === 'verified')
                ?.after_snapshot;
        if (!expected) throw new Error('VARIATION_PREVIOUS_STAGE_REQUIRED');
        const client = await this.client(input);
        const before = await this.read(client, input.intent.itemId);
        if (before.kind !== 'success') throw new Error('VARIATION_PREFLIGHT_UNAVAILABLE');
        if (
          variationBaselineFingerprint(before.response) !== variationBaselineFingerprint(expected)
        )
          throw new Error('VARIATION_BASELINE_CHANGED');
        // A future/queued promotion may be absent from the product's current-price flags.
        if (
          input.intent.added.length ||
          input.intent.removedModelIds.length ||
          input.intent.replaceAllModels
        ) {
          const promotion = await client.read('/api/v2/product/get_item_promotion', {
            item_id_list: input.intent.itemId,
          });
          if (promotion.kind !== 'success') throw new Error('VARIATION_PROMOTION_UNAVAILABLE');
          const refreshedPlan = planVariationMutation(input.intent, {
            ...input.context,
            promotionSnapshot: promotion.envelope,
          });
          if (refreshedPlan.kind !== 'ready') throw new Error('VARIATION_PROMOTION_CHANGED');
        }
        const sent = await transaction(this.repo.pool, async (c) => {
          if (
            !(
              await c.query(
                "SELECT 1 FROM variation_operations WHERE id=$1 AND claim_id=$2 AND state='running' AND lease_until>$3 FOR UPDATE",
                [id, claim, this.now()],
              )
            ).rowCount
          )
            return false;
          const connection = (
            await c.query('SELECT * FROM connections WHERE id=$1 FOR SHARE', [input.connectionId])
          ).rows[0];
          this.validConnection(connection, input);
          await c.query(
            "INSERT INTO variation_steps(operation_id,ordinal,path,payload,before_snapshot,state,sent_at) VALUES($1,$2,$3,$4,$5,'sent',$6)",
            [id, index, stage.path, stage.payload, before.response, this.now()],
          );
          await c.query('UPDATE variation_operations SET lease_until=$2 WHERE id=$1', [
            id,
            new Date(this.now().getTime() + 120000),
          ]);
          return true;
        });
        if (!sent) return this.get(id);
        const receipt = await client.write(stage.path, stage.payload);
        const qc =
          receipt.kind === 'success'
            ? await pollPreparedReadback({
                read: (signal) => this.read(client, input.intent.itemId, signal),
                check: (after) =>
                  checkVariationMutationStage(
                    plan,
                    stage.ordinal,
                    before.response,
                    after,
                    receipt.envelope,
                  ),
                delaysMs: this.options.readbackDelaysMs,
                pause: this.options.pause,
              })
            : { state: 'unresolved' as const, observations: [] };
        const after = qc.observations.at(-1)?.snapshot;
        await transaction(this.repo.pool, async (c) => {
          if (
            !(
              await c.query(
                "SELECT 1 FROM variation_operations WHERE id=$1 AND claim_id=$2 AND state='running' FOR UPDATE",
                [id, claim],
              )
            ).rowCount
          )
            return;
          await c.query(
            "UPDATE variation_steps SET state=$3,receipt=$4,qc=$5,after_snapshot=$6,verified_at=$7 WHERE operation_id=$1 AND ordinal=$2 AND state='sent'",
            [
              id,
              index,
              qc.state === 'verified' ? 'verified' : 'unknown',
              receipt,
              qc,
              after ?? null,
              qc.state === 'verified' ? this.now() : null,
            ],
          );
          if (qc.state !== 'verified')
            await c.query(
              "UPDATE variation_operations SET state='unknown',claim_id=NULL,lease_until=NULL,result=$2,updated_at=$3 WHERE id=$1",
              [id, { code: 'VARIATION_STAGE_UNRESOLVED', ordinal: index }, this.now()],
            );
        });
        if (qc.state !== 'verified') return this.get(id);
      }
      await this.repo.pool.query(
        "UPDATE variation_operations SET state='verified',claim_id=NULL,lease_until=NULL,result=$3,updated_at=$4 WHERE id=$1 AND claim_id=$2 AND state='running'",
        [id, claim, { code: 'VARIATION_ALL_STAGES_READBACK_VERIFIED' }, this.now()],
      );
    } catch (error) {
      const code =
        error instanceof Error && /^VARIATION_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'VARIATION_INTERRUPTED';
      await this.repo.pool.query(
        "UPDATE variation_operations SET state=CASE WHEN EXISTS(SELECT 1 FROM variation_steps WHERE operation_id=$1) THEN 'unknown' ELSE 'blocked' END,claim_id=NULL,lease_until=NULL,result=$3,updated_at=$4 WHERE id=$1 AND claim_id=$2 AND state='running'",
        [id, claim, { code }, this.now()],
      );
    }
    return this.get(id);
  }
}
