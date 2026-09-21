import { randomUUID, createHash } from 'node:crypto';
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
  bindPreparedWireItem,
  inspectPreparedWireAcknowledgement,
  type PreparedAllowedShop,
  type PreparedWirePlan,
  type PreparedWireStep,
} from '@shopee/gateway';

type ReadyPlan = Extract<PreparedWirePlan, { kind: 'ready' }>;
export type PreparedWireInput = {
  id: string;
  connectionId: string;
  scope: Scope;
  sourceKey: string;
  sourceFingerprint: string;
  plan: ReadyPlan;
};
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const owner = (scope: Scope) => `${scope.environment}:${scope.partnerId}:${scope.shopId}`;
const planSchema = z
  .object({
    kind: z.literal('ready'),
    operation: z.enum(['create', 'update']),
    steps: z
      .array(
        z
          .object({
            path: z.enum([
              '/api/v2/product/add_item',
              '/api/v2/product/init_tier_variation',
              '/api/v2/product/update_item',
              '/api/v2/product/update_model',
              '/api/v2/product/update_tier_variation',
              '/api/v2/product/update_price',
              '/api/v2/product/update_stock',
            ]),
            method: z.literal('POST'),
            payload: z.record(z.string(), z.unknown()),
            group: z.enum([
              'create',
              'variations',
              'title',
              'description',
              'cover',
              'gallery',
              'variationImages',
              'price',
              'stock',
              'attributes',
              'logistics',
            ]),
            minDelayAfterCreateMs: z.number().int().min(5000).max(60000).optional(),
            expectedModelIds: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
const schema = z
  .object({
    id: z.string().uuid(),
    connectionId: z.string().uuid(),
    sourceKey: z.string().min(1).max(200),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    scope: z
      .object({
        environment: z.literal('sandbox'),
        partnerId: z.string().regex(/^[1-9]\d*$/),
        shopId: z.string().regex(/^[1-9]\d*$/),
        connectionRevision: z.number().int().positive(),
        capabilityRevision: z.number().int().nonnegative(),
      })
      .strict(),
    plan: planSchema,
  })
  .strict();

/** Explicitly invoked sandbox bridge. This class never marks an acknowledgement as QC verified. */
export class PreparedWireRunner {
  constructor(
    readonly repo: Repository,
    readonly options: {
      allowedShops: PreparedAllowedShop[];
      encryptionKey?: string;
      transport?: typeof fetch;
      now?: () => Date;
      pause?: (ms: number) => Promise<void>;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? new Date();
  }
  private async context(input: PreparedWireInput) {
    const row = (
      await this.repo.pool.query('SELECT * FROM connections WHERE id=$1', [input.connectionId])
    ).rows[0];
    if (
      !row ||
      row.environment !== 'sandbox' ||
      row.partner_id !== input.scope.partnerId ||
      row.shop_id !== input.scope.shopId ||
      !this.options.allowedShops.some(
        (s) => s.partnerId === row.partner_id && s.shopId === row.shop_id,
      )
    )
      throw new Error('PREPARED_WIRE_SCOPE_FORBIDDEN');
    if (
      row.revision !== input.scope.connectionRevision ||
      row.capability_revision !== input.scope.capabilityRevision
    )
      throw new Error('PREPARED_WIRE_CONNECTION_CHANGED');
    if (
      row.state !== 'connected' ||
      (row.expires_at && new Date(row.expires_at).getTime() <= this.now().getTime())
    )
      throw new Error('PREPARED_WIRE_AUTH_REQUIRED');
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
      throw new Error('PREPARED_WIRE_AUTH_REQUIRED');
    }
  }
  async prepare(raw: PreparedWireInput) {
    const input = schema.parse(raw) as PreparedWireInput;
    const adds = input.plan.steps.filter((s) => s.path.endsWith('/add_item'));
    if (
      (input.plan.operation === 'create' &&
        (adds.length !== 1 || input.plan.steps[0] !== adds[0])) ||
      (input.plan.operation === 'update' && adds.length)
    )
      throw new Error('PREPARED_WIRE_PLAN_INVALID');
    if (input.plan.operation === 'create') {
      if (
        adds[0]!.payload.item_status !== 'UNLIST' ||
        input.plan.steps.length > 2 ||
        input.plan.steps
          .slice(1)
          .some(
            (s) =>
              s.path !== '/api/v2/product/init_tier_variation' ||
              s.payload.item_id !== '$created_item_id',
          )
      )
        throw new Error('PREPARED_WIRE_PLAN_INVALID');
    } else {
      const targets = input.plan.steps.map((s) => String(s.payload.item_id));
      if (
        new Set(targets).size !== 1 ||
        !/^[1-9]\d*$/.test(targets[0]!) ||
        !Number.isSafeInteger(Number(targets[0])) ||
        ['803934364', '846056124'].includes(targets[0]!) ||
        input.plan.steps.some((s) => s.path.endsWith('/init_tier_variation'))
      )
        throw new Error('PREPARED_WIRE_PLAN_INVALID');
    }
    await this.context(input);
    const { id: _, scope: scopeInput, ...semantic } = input;
    const fingerprint = hash({
      ...semantic,
      scope: {
        environment: scopeInput.environment,
        partnerId: scopeInput.partnerId,
        shopId: scopeInput.shopId,
      },
    });
    return transaction(this.repo.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'prepared-wire:' + owner(input.scope),
      ]);
      const old = (
        await c.query(
          'SELECT * FROM prepared_wire_operations WHERE id=$1 OR (owner_key=$2 AND fingerprint=$3)',
          [input.id, owner(input.scope), fingerprint],
        )
      ).rows[0];
      if (old) {
        if (old.fingerprint !== fingerprint) throw new Error('PREPARED_WIRE_INTENT_CONFLICT');
        const steps = (
          await c.query(
            'SELECT * FROM prepared_wire_steps WHERE operation_id=$1 ORDER BY ordinal',
            [old.id],
          )
        ).rows;
        return this.public(old, steps);
      }
      if (
        input.plan.operation === 'create' &&
        (
          await c.query(
            "SELECT 1 FROM prepared_wire_operations WHERE owner_key=$1 AND source_key=$2 AND input->'plan'->>'operation'='create' AND state<>'blocked'",
            [owner(input.scope), input.sourceKey],
          )
        ).rowCount
      )
        throw new Error('PREPARED_WIRE_CREATE_SOURCE_EXISTS');
      const itemId =
        input.plan.operation === 'update' ? String(input.plan.steps[0]!.payload.item_id) : null;
      const row = (
        await c.query(
          "INSERT INTO prepared_wire_operations(id,connection_id,owner_key,source_key,fingerprint,input,state,item_id) VALUES($1,$2,$3,$4,$5,$6,'prepared',$7) RETURNING *",
          [
            input.id,
            input.connectionId,
            owner(input.scope),
            input.sourceKey,
            fingerprint,
            input,
            itemId,
          ],
        )
      ).rows[0];
      return this.public(row, []);
    });
  }
  private public(row: any, steps: any[]) {
    return {
      id: row.id,
      input: row.input,
      fingerprint: row.fingerprint,
      state: row.state,
      itemId: row.item_id,
      result: row.result,
      steps: steps.map((s) => ({
        ordinal: s.ordinal,
        path: s.path,
        payload: s.payload,
        state: s.state,
        receipt: s.receipt,
        sentAt: s.sent_at,
        acknowledgedAt: s.acknowledged_at,
      })),
    };
  }
  async get(id: string) {
    const row = (
      await this.repo.pool.query('SELECT * FROM prepared_wire_operations WHERE id=$1', [
        z.string().uuid().parse(id),
      ])
    ).rows[0];
    if (!row) throw new Error('PREPARED_WIRE_NOT_FOUND');
    const steps = (
      await this.repo.pool.query(
        'SELECT * FROM prepared_wire_steps WHERE operation_id=$1 ORDER BY ordinal',
        [id],
      )
    ).rows;
    return this.public(row, steps);
  }
  private async stop(id: string, claim: string, code: string) {
    await this.repo.pool.query(
      "UPDATE prepared_wire_operations SET state=CASE WHEN EXISTS(SELECT 1 FROM prepared_wire_steps WHERE operation_id=$1) THEN 'unknown' ELSE 'blocked' END,result=$3,claim_id=NULL,lease_until=NULL,updated_at=$4 WHERE id=$1 AND claim_id=$2 AND state='running'",
      [id, claim, { code }, this.now()],
    );
  }
  async run(id: string) {
    const claim = randomUUID();
    const row = await transaction(this.repo.pool, async (c) => {
      const current = (
        await c.query('SELECT * FROM prepared_wire_operations WHERE id=$1 FOR UPDATE', [
          z.string().uuid().parse(id),
        ])
      ).rows[0];
      if (!current) throw new Error('PREPARED_WIRE_NOT_FOUND');
      if (
        !['prepared', 'running'].includes(current.state) ||
        (current.state === 'running' &&
          new Date(current.lease_until).getTime() > this.now().getTime())
      )
        return null;
      await lockSandboxMutationLane(c, current.owner_key);
      if (await sandboxMutationLaneBusy(c, current.owner_key, { family: 'wire', id })) return null;
      if (
        (
          await c.query(
            "SELECT 1 FROM prepared_wire_steps WHERE operation_id=$1 AND state<>'acknowledged'",
            [id],
          )
        ).rowCount
      ) {
        await c.query(
          "UPDATE prepared_wire_operations SET state='unknown',claim_id=NULL,lease_until=NULL,result=$2 WHERE id=$1",
          [id, { code: 'PREPARED_WIRE_UNRESOLVED_STAGE' }],
        );
        return null;
      }
      return (
        await c.query(
          "UPDATE prepared_wire_operations SET state='running',claim_id=$2,lease_until=$3,updated_at=$4 WHERE id=$1 RETURNING *",
          [id, claim, new Date(this.now().getTime() + 120000), this.now()],
        )
      ).rows[0];
    });
    if (!row) return this.get(id);
    const input: PreparedWireInput = row.input;
    try {
      for (let ordinal = 0; ordinal < input.plan.steps.length; ordinal++) {
        const saved = await this.get(id);
        if (saved.steps.some((s) => s.ordinal === ordinal && s.state === 'acknowledged')) continue;
        const stage = input.plan.steps[ordinal]!;
        if (stage.path.endsWith('/init_tier_variation')) {
          const created = saved.steps.find(
            (s) => s.path.endsWith('/add_item') && s.state === 'acknowledged',
          );
          if (!created || !saved.itemId) throw new Error('PREPARED_WIRE_CREATED_ID_REQUIRED');
          const delay =
            new Date(created.acknowledgedAt).getTime() +
            Math.max(5000, stage.minDelayAfterCreateMs ?? 5000) -
            this.now().getTime();
          if (delay > 0)
            await (this.options.pause?.(delay) ?? new Promise((r) => setTimeout(r, delay)));
        }
        const bound: PreparedWireStep = saved.itemId
          ? bindPreparedWireItem(stage, saved.itemId)
          : stage;
        const client = await this.context(input);
        const sent = await transaction(this.repo.pool, async (c) => {
          const own = (
            await c.query(
              "SELECT 1 FROM prepared_wire_operations WHERE id=$1 AND claim_id=$2 AND state='running' AND lease_until>$3 FOR UPDATE",
              [id, claim, this.now()],
            )
          ).rowCount;
          if (!own) return false;
          const connection = (
            await c.query(
              'SELECT environment,partner_id,shop_id,revision,capability_revision,state,expires_at FROM connections WHERE id=$1 FOR SHARE',
              [input.connectionId],
            )
          ).rows[0];
          if (
            !connection ||
            connection.environment !== 'sandbox' ||
            connection.partner_id !== input.scope.partnerId ||
            connection.shop_id !== input.scope.shopId ||
            connection.revision !== input.scope.connectionRevision ||
            connection.capability_revision !== input.scope.capabilityRevision ||
            connection.state !== 'connected' ||
            (connection.expires_at &&
              new Date(connection.expires_at).getTime() <= this.now().getTime())
          )
            throw new Error('PREPARED_WIRE_CONNECTION_CHANGED');
          await c.query(
            "INSERT INTO prepared_wire_steps(operation_id,ordinal,path,payload,fingerprint,state,sent_at) VALUES($1,$2,$3,$4,$5,'sent',$6)",
            [id, ordinal, bound.path, bound.payload, hash(bound), this.now()],
          );
          await c.query(
            'UPDATE prepared_wire_operations SET lease_until=$3,updated_at=$4 WHERE id=$1 AND claim_id=$2',
            [id, claim, new Date(this.now().getTime() + 120000), this.now()],
          );
          return true;
        });
        if (!sent) return this.get(id);
        const receipt = await client.write(bound.path, bound.payload);
        const acknowledgement =
          receipt.kind === 'success'
            ? inspectPreparedWireAcknowledgement(bound, receipt.envelope)
            : { success: false, kind: 'unknown', issues: [{ code: receipt.code }] };
        await transaction(this.repo.pool, async (c) => {
          const current = (
            await c.query(
              "SELECT * FROM prepared_wire_operations WHERE id=$1 AND claim_id=$2 AND state='running' FOR UPDATE",
              [id, claim],
            )
          ).rows[0];
          if (!current) return;
          await c.query(
            "UPDATE prepared_wire_steps SET state=$3,receipt=$4,acknowledged_at=$5 WHERE operation_id=$1 AND ordinal=$2 AND state='sent'",
            [
              id,
              ordinal,
              acknowledgement.success ? 'acknowledged' : 'unknown',
              { receipt, acknowledgement },
              acknowledgement.success ? this.now() : null,
            ],
          );
          const itemId = 'createdItemId' in acknowledgement ? acknowledgement.createdItemId : null;
          await c.query(
            'UPDATE prepared_wire_operations SET item_id=COALESCE(item_id,$3),state=$4,result=$5,updated_at=$6 WHERE id=$1 AND claim_id=$2',
            [
              id,
              claim,
              itemId,
              acknowledgement.success ? 'running' : 'unknown',
              {
                code: acknowledgement.success
                  ? 'PREPARED_WIRE_STAGE_ACKNOWLEDGED'
                  : 'PREPARED_WIRE_STAGE_UNRESOLVED',
                ordinal,
              },
              this.now(),
            ],
          );
        });
        if (!acknowledgement.success) return this.get(id);
      }
      await this.repo.pool.query(
        "UPDATE prepared_wire_operations SET state='acknowledged',claim_id=NULL,lease_until=NULL,result=$3,updated_at=$4 WHERE id=$1 AND claim_id=$2 AND state='running'",
        [id, claim, { code: 'PREPARED_WIRE_ACKNOWLEDGED_QC_REQUIRED' }, this.now()],
      );
    } catch (error) {
      const message =
        error instanceof Error && /^PREPARED_WIRE_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'PREPARED_WIRE_INTERRUPTED';
      await this.stop(id, claim, message);
    }
    return this.get(id);
  }
}
