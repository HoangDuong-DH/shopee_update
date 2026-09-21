import { z } from 'zod';
import {
  Repository,
  transaction,
  lockSandboxMutationLane,
  sandboxMutationLaneBusy,
} from '@shopee/persistence';
import {
  SandboxFieldClient,
  SandboxCreateClient,
  SecretBox,
  fieldOperationSchema,
  productFingerprint,
  type FieldSnapshot,
  type ProductOutcome,
} from '@shopee/gateway';
import {
  checkFieldReadback,
  fieldSnapshotFingerprint,
  validateFieldBaseline,
} from './sandbox-field-checks.js';

const inputSchema = z
  .object({
    id: z.string().uuid(),
    trialItemId: z.string().uuid(),
    connectionRevision: z.number().int().positive(),
    operation: fieldOperationSchema,
  })
  .strict();
const scope = 'sandbox:1232297:227418363';
const lockSql =
  "SELECT pg_advisory_xact_lock(hashtextextended('prepared-wire:sandbox:1232297:227418363',0))";
function succeeded<T>(result: ProductOutcome<T>): T {
  if (result.kind === 'success') return result.data;
  throw new Error(
    result.kind === 'rejected' ? 'FIELD_API_REJECTED:' + result.code : 'FIELD_READ_UNKNOWN',
  );
}
function publicRow(row: any): any {
  return {
    id: row.id,
    trialItemId: row.trial_item_id,
    connectionId: row.connection_id,
    connectionRevision: row.connection_revision,
    itemId: row.item_id,
    fingerprint: row.fingerprint,
    input: row.input,
    baseline: row.baseline,
    operation: row.operation,
    state: row.state,
    result: row.result,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}
/** Bounded technical acceptance only. Business receipts and protected Lamy never enter this executor. */
export class SandboxFieldTrialService {
  constructor(
    readonly repo: Repository,
    readonly options: {
      transport?: typeof fetch;
      encryptionKey?: string;
      pause?: () => Promise<void>;
    } = {},
  ) {}
  private async context(trialItemId: string, revision: number) {
    const binding = (
      await this.repo.pool.query('SELECT * FROM sandbox_create_trial_items WHERE id=$1', [
        trialItemId,
      ])
    ).rows[0];
    if (
      !binding ||
      binding.state !== 'verified' ||
      binding.stage !== 'done' ||
      !binding.item_id ||
      ['803934364', '846056124'].includes(binding.item_id) ||
      !/^SBX-BULK-/.test(binding.source_key)
    )
      throw new Error('FIELD_TARGET_NOT_ALLOWED');
    const row = (
      await this.repo.pool.query('SELECT * FROM connections WHERE id=$1', [binding.connection_id])
    ).rows[0];
    if (
      !row ||
      row.environment !== 'sandbox' ||
      row.partner_id !== '1232297' ||
      row.shop_id !== '227418363'
    )
      throw new Error('FIELD_TARGET_NOT_ALLOWED');
    if (row.revision !== revision) throw new Error('FIELD_CONNECTION_CHANGED');
    if (row.state !== 'connected' || !row.token_ciphertext || !row.partner_key_ciphertext)
      throw new Error('FIELD_AUTH_REQUIRED');
    const box = new SecretBox(this.options.encryptionKey ?? process.env.APP_ENCRYPTION_KEY ?? '');
    let secrets: { partnerKey: string; accessToken: string };
    try {
      secrets = z.object({ partnerKey: z.string().min(1), accessToken: z.string().min(1) }).parse({
        ...(box.open(row.partner_key_ciphertext, scope) as object),
        ...(box.open(row.token_ciphertext, scope) as object),
      });
    } catch {
      throw new Error('FIELD_AUTH_REQUIRED');
    }
    const credentials = {
      environment: 'sandbox' as const,
      partnerId: '1232297',
      shopId: '227418363',
      ...secrets,
    };
    const sanitizeDiagnostic = <T>(value: T): T => {
      const redact = (text: string) =>
        [secrets.accessToken, secrets.partnerKey].reduce(
          (clean, secret) => clean.replaceAll(secret, '[redacted]'),
          text,
        );
      const visit = (value: unknown): unknown => {
        if (typeof value === 'string') return redact(value);
        if (Array.isArray(value)) return value.map(visit);
        if (value && typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value).map(([name, entry]) => [redact(name), visit(entry)]),
          );
        return value;
      };
      return visit(value) as T;
    };
    return {
      binding,
      client: new SandboxFieldClient(credentials, this.options.transport),
      metadata: new SandboxCreateClient(credentials, this.options.transport),
      sanitizeDiagnostic,
    };
  }
  private assertTarget(binding: any, snapshot: FieldSnapshot) {
    if (
      String(snapshot.item.item_id) !== binding.item_id ||
      snapshot.item.item_sku !== binding.source_key ||
      snapshot.item.item_status !== 'UNLIST' ||
      !String(snapshot.item.item_name).startsWith('SANDBOX QA ') ||
      snapshot.item.category_id !== binding.intent.create.category_id
    )
      throw new Error('FIELD_REMOTE_TARGET_CHANGED');
    const sourceModels = binding.intent.tiers?.model ?? [];
    if (!sourceModels.length) {
      if (snapshot.item.has_model !== false || snapshot.models.model.length)
        throw new Error('FIELD_MODEL_BINDING_CHANGED');
    } else {
      const boundModels = binding.result?.evidence?.models?.model;
      if (
        snapshot.item.has_model !== true ||
        !Array.isArray(boundModels) ||
        boundModels.length !== sourceModels.length ||
        snapshot.models.model.length !== sourceModels.length
      )
        throw new Error('FIELD_MODEL_BINDING_CHANGED');
      for (const source of sourceModels) {
        const actual = snapshot.models.model.filter((m) => m.model_sku === source.model_sku),
          bound = boundModels.filter((m: any) => m.model_sku === source.model_sku);
        if (
          actual.length !== 1 ||
          bound.length !== 1 ||
          String(actual[0]!.model_id) !== String(bound[0].model_id) ||
          productFingerprint(actual[0]!.tier_index) !== productFingerprint(source.tier_index)
        )
          throw new Error('FIELD_MODEL_BINDING_CHANGED');
      }
      const priorStructure = { ...binding.result.evidence.models, model: [] };
      const currentStructure = { ...snapshot.models, model: [] };
      if (
        fieldSnapshotFingerprint({ item: {}, models: priorStructure }) !==
        fieldSnapshotFingerprint({ item: {}, models: currentStructure })
      )
        throw new Error('FIELD_MODEL_BINDING_CHANGED');
    }
  }
  async get(id: string) {
    const row = (
      await this.repo.pool.query('SELECT * FROM sandbox_field_trials WHERE id=$1', [
        z.string().uuid().parse(id),
      ])
    ).rows[0];
    if (!row) throw new Error('FIELD_NOT_FOUND');
    return publicRow(row);
  }
  /** Evidence only: no receipt, write intent, price-guard override, or Shopee mutation. */
  async inspect(raw: unknown) {
    const input = z
      .object({
        trialItemId: z.string().uuid(),
        connectionRevision: z.number().int().positive(),
      })
      .strict()
      .parse(raw);
    const { binding, client, sanitizeDiagnostic } = await this.context(
      input.trialItemId,
      input.connectionRevision,
    );
    const snapshot = await client.read(binding.item_id);
    if (snapshot.kind === 'success') this.assertTarget(binding, snapshot.data);
    const promotions =
      snapshot.kind === 'success' ? await client.readPromotions(binding.item_id) : null;
    const connection = (
      await this.repo.pool.query('SELECT revision,state FROM connections WHERE id=$1', [
        binding.connection_id,
      ])
    ).rows[0];
    if (connection?.revision !== input.connectionRevision || connection.state !== 'connected')
      throw new Error('FIELD_CONNECTION_CHANGED');
    return sanitizeDiagnostic({
      diagnosticOnly: true as const,
      mutationSent: false as const,
      trialItemId: input.trialItemId,
      connectionRevision: input.connectionRevision,
      itemId: binding.item_id as string,
      observedAt: new Date().toISOString(),
      snapshot,
      promotions,
    });
  }
  async prepare(raw: unknown) {
    const input = inputSchema.parse(raw);
    const prior = (
      await this.repo.pool.query('SELECT * FROM sandbox_field_trials WHERE id=$1', [input.id])
    ).rows[0];
    if (prior) {
      if (productFingerprint(prior.input) !== productFingerprint(input))
        throw new Error('FIELD_INTENT_CONFLICT');
      return publicRow(prior);
    }
    const { binding, client, metadata } = await this.context(
      input.trialItemId,
      input.connectionRevision,
    );
    const before = succeeded(await client.read(binding.item_id));
    this.assertTarget(binding, before);
    validateFieldBaseline(before, input.operation);
    const op = input.operation;
    if (op.kind === 'title' && !op.value.startsWith('SANDBOX QA '))
      throw new Error('FIELD_SOURCE_NOT_TECHNICAL');
    if (op.kind === 'description' && !JSON.stringify(op.value).includes('SANDBOX ONLY'))
      throw new Error('FIELD_SOURCE_NOT_TECHNICAL');
    const ids = new Set<string>(binding.intent.create.image.image_id_list);
    const imageIds =
      op.kind === 'gallery'
        ? op.value.image_id_list
        : op.kind === 'cover'
          ? op.value
          : op.kind === 'description' && op.value.description_type === 'extended'
            ? op.value.description_info.extended_description.field_list.flatMap((b) =>
                b.field_type === 'image' ? [b.image_info.image_id] : [],
              )
            : [];
    if (imageIds.some((id) => !ids.has(id))) throw new Error('FIELD_IMAGE_SOURCE_UNVERIFIED');
    if (
      op.kind === 'price' ||
      op.kind === 'stock' ||
      op.kind === 'title' ||
      op.kind === 'description' ||
      op.kind === 'gallery'
    ) {
      const limits = succeeded(await metadata.creationLimits(String(before.item.category_id)));
      const range = (key: string, values: number[]) => {
        const r = z
          .object({ min_limit: z.number().finite(), max_limit: z.number().finite() })
          .safeParse(limits[key]);
        if (
          !r.success ||
          r.data.max_limit < r.data.min_limit ||
          values.some((v) => v < r.data.min_limit || v > r.data.max_limit)
        )
          throw new Error('FIELD_LIMIT_UNVERIFIED');
      };
      if (op.kind === 'price')
        range(
          'price_limit',
          op.value.map((v) => v.original_price),
        );
      if (op.kind === 'stock')
        range(
          'stock_limit',
          op.value.flatMap((v) => v.seller_stock.map((s) => s.stock)),
        );
      if (op.kind === 'title') range('item_name_length_limit', [[...op.value].length]);
      if (op.kind === 'gallery') range('item_image_count_limit', [op.value.image_id_list.length]);
      if (op.kind === 'description') {
        if (op.value.description_type === 'normal')
          range('item_description_length_limit', [[...op.value.description].length]);
        else throw new Error('FIELD_EXTENDED_LIMIT_UNVERIFIED');
      }
    }
    const fingerprint = productFingerprint({ input, before });
    return transaction(this.repo.pool, async (c) => {
      await c.query(lockSql);
      const fresh = (
        await c.query('SELECT revision FROM connections WHERE id=$1 FOR UPDATE', [
          binding.connection_id,
        ])
      ).rows[0];
      if (fresh?.revision !== input.connectionRevision) throw new Error('FIELD_CONNECTION_CHANGED');
      await c.query(
        "INSERT INTO sandbox_field_trials(id,trial_item_id,connection_id,connection_revision,item_id,fingerprint,input,baseline,operation,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'prepared') ON CONFLICT(id) DO NOTHING",
        [
          input.id,
          input.trialItemId,
          binding.connection_id,
          input.connectionRevision,
          binding.item_id,
          fingerprint,
          input,
          before,
          op,
        ],
      );
      const row = (await c.query('SELECT * FROM sandbox_field_trials WHERE id=$1', [input.id]))
        .rows[0];
      if (productFingerprint(row.input) !== productFingerprint(input))
        throw new Error('FIELD_INTENT_CONFLICT');
      return publicRow(row);
    });
  }
  /** Cancels only a never-sent prepared intent. A competing writer's unknown state is preserved. */
  async cancel(raw: unknown) {
    const input = z
      .object({ id: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(raw);
    return transaction(this.repo.pool, async (c) => {
      await lockSandboxMutationLane(c, scope);
      const row = (
        await c.query('SELECT * FROM sandbox_field_trials WHERE id=$1 FOR UPDATE', [input.id])
      ).rows[0];
      if (!row) throw new Error('FIELD_NOT_FOUND');
      if (row.fingerprint !== input.fingerprint) throw new Error('FIELD_INTENT_CONFLICT');
      if (row.state !== 'prepared') return publicRow(row);
      const canceled = (
        await c.query(
          "UPDATE sandbox_field_trials SET state='blocked',result=$2,updated_at=now() WHERE id=$1 AND state='prepared' RETURNING *",
          [input.id, { code: 'DRAFT_CANCELLED', mutationSent: false }],
        )
      ).rows[0];
      return publicRow(canceled);
    });
  }
  async execute(raw: unknown) {
    const input = z
      .object({ id: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(raw);
    const run = await this.get(input.id);
    if (run.fingerprint !== input.fingerprint) throw new Error('FIELD_INTENT_CONFLICT');
    if (run.state !== 'prepared') return run;
    const { binding, client } = await this.context(run.trialItemId, run.connectionRevision);
    if (Date.now() - Date.parse(run.createdAt) > 15 * 60_000)
      throw new Error('FIELD_PREPARATION_EXPIRED');
    const fresh = succeeded(await client.read(run.itemId));
    this.assertTarget(binding, fresh);
    if (fieldSnapshotFingerprint(fresh) !== fieldSnapshotFingerprint(run.baseline)) {
      await this.repo.pool.query(
        "UPDATE sandbox_field_trials SET state='blocked',result=$2,updated_at=now() WHERE id=$1 AND state='prepared'",
        [run.id, { code: 'BASELINE_CHANGED', before: fresh }],
      );
      return this.get(run.id);
    }
    const claimed = await transaction(this.repo.pool, async (c) => {
      await lockSandboxMutationLane(c, scope);
      const current = (
        await c.query('SELECT * FROM sandbox_field_trials WHERE id=$1 FOR UPDATE', [run.id])
      ).rows[0];
      if (current.state !== 'prepared') return false;
      if (await sandboxMutationLaneBusy(c, scope, { family: 'field', id: run.id }))
        throw new Error('FIELD_SHOP_BUSY');
      const connection = (
        await c.query('SELECT revision,state FROM connections WHERE id=$1 FOR UPDATE', [
          run.connectionId,
        ])
      ).rows[0];
      if (connection?.revision !== run.connectionRevision || connection.state !== 'connected')
        throw new Error('FIELD_CONNECTION_CHANGED');
      if (
        (
          await c.query(
            "SELECT id FROM sandbox_field_trials WHERE state='unknown' UNION ALL SELECT id FROM sandbox_create_trial_items WHERE state IN ('queued','running','waiting') OR (state='unknown' AND stage IN ('create_intent','tiers_intent')) LIMIT 1",
          )
        ).rowCount
      )
        throw new Error('FIELD_SHOP_BUSY');
      // Unknown is durable BEFORE the network write, so process loss cannot cause automatic replay.
      await c.query(
        "UPDATE sandbox_field_trials SET state='unknown',started_at=now(),updated_at=now(),result=$2 WHERE id=$1",
        [run.id, { code: 'WRITE_INTENT_RECORDED' }],
      );
      return true;
    });
    if (!claimed) return this.get(run.id);
    // The durable lane is now exclusive across all connections for this fixed TEST owner.
    // A fresh read outside the lane could have raced another completed field operation.
    const lockedRead = await client.read(run.itemId);
    let safe = false;
    if (lockedRead.kind === 'success') {
      try {
        this.assertTarget(binding, lockedRead.data);
        safe = fieldSnapshotFingerprint(lockedRead.data) === fieldSnapshotFingerprint(run.baseline);
      } catch {
        safe = false;
      }
    }
    if (!safe) {
      await this.repo.pool.query(
        "UPDATE sandbox_field_trials SET state='blocked',result=$2,updated_at=now() WHERE id=$1 AND state='unknown'",
        [
          run.id,
          {
            code: 'PREWRITE_READ_CHANGED_OR_UNAVAILABLE',
            readback: lockedRead,
            mutationSent: false,
          },
        ],
      );
      return this.get(run.id);
    }
    const acknowledgement = await client.execute(run.itemId, run.operation);
    let last: ProductOutcome<FieldSnapshot> | undefined,
      check: ReturnType<typeof checkFieldReadback> | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      await (this.options.pause?.() ?? new Promise((resolve) => setTimeout(resolve, 1500)));
      last = await client.read(run.itemId);
      if (last.kind === 'success') {
        try {
          check = checkFieldReadback(run.baseline, last.data, run.operation);
        } catch {
          check = undefined;
        }
        if (check?.verified) break;
      } else if (last.kind === 'rejected') break;
    }
    const verified = check?.verified === true;
    // Readback is authoritative; a returned failure/timeout still never authorizes a second mutation.
    await this.repo.pool.query(
      "UPDATE sandbox_field_trials SET state=$2,result=$3,updated_at=now() WHERE id=$1 AND state='unknown'",
      [
        run.id,
        verified ? 'verified' : 'unknown',
        {
          code: verified ? 'READBACK_VERIFIED' : 'READBACK_UNRESOLVED',
          acknowledgement,
          check: check ?? null,
          readback: last ?? null,
        },
      ],
    );
    return this.get(run.id);
  }
}
