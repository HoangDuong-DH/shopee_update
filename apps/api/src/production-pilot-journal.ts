import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Repository, transaction } from '@shopee/persistence';
import { canonicalJson } from '@shopee/domain';
import { coreProjectionWithoutImages, assertDeferredImageVerification } from './production-pilot-image-deferral.js';
import type { ExecutionPolicyReceipt } from './production-execution-policy.js';
import {
  productionPilotUploadFingerprint,
  productionPilotWriteFingerprint,
  type ProductionPilotImageOptions,
  type ProductionPilotMutationIntent,
} from '../../../packages/shopee/src/production-pilot-transport.js';
import {
  assertProductionPilotBatchBinding, bindProductionPilotBatchAuthorization,
  parseProductionPilotBatchAuthorization, type ProductionPilotBatchAuthorization,
} from './production-pilot-batch-authorization.js';
export type { ProductionPilotBatchAuthorization } from './production-pilot-batch-authorization.js';

const scope = Object.freeze({
  environment: 'production',
  partnerId: '2010476',
  shopId: '1423724897',
});
const owner = 'production:2010476:1423724897';
const pathFor = {
  create: '/api/v2/product/add_item',
  variations: '/api/v2/product/init_tier_variation',
} as const;
const uuid = z.string().uuid(),
  revision = z.number().int().positive();
const sourceSchema = z
  .object({ sourceIdentity: z.string().min(1).max(200), sourceRevision: revision })
  .strict();
const stepKey = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const fingerprint = (value: unknown) => sha(canonicalJson(value));
const fail = (code: string): never => {
  throw new Error('PRODUCTION_PILOT_' + code);
};
const secretFields = new Set([
  'partner_key',
  'partnerKey',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'password',
  'authorization',
]);

/** JSON snapshots are copied before any await. Credentials and executable/toJSON values are not journal data. */
function snapshot(value: unknown, maximumNodes = 100000): Record<string, unknown> {
  let nodes = 0;
  const copy = (entry: unknown, depth: number): unknown => {
    if (++nodes > maximumNodes || depth > 50) return fail('INVALID_SNAPSHOT');
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) {
      if (entry.length > 100000) return fail('INVALID_SNAPSHOT');
      return Array.from({ length: entry.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return fail('INVALID_SNAPSHOT');
        return copy(descriptor.value, depth + 1);
      });
    }
    if (
      !entry ||
      typeof entry !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(entry))
    )
      return fail('INVALID_SNAPSHOT');
    return Object.fromEntries(
      Object.keys(entry).map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(entry, key)!;
        if (
          !Object.hasOwn(descriptor, 'value') ||
          (secretFields.has(key) && !['[redacted]', '[REDACTED]'].includes(descriptor.value))
        )
          return fail('INVALID_SNAPSHOT');
        return [key, copy(descriptor.value, depth + 1)];
      }),
    );
  };
  const result = copy(value, 0);
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    Buffer.byteLength(JSON.stringify(result)) > 16_000_000
  )
    return fail('INVALID_SNAPSHOT');
  return result as Record<string, unknown>;
}

export type ProductionPilotSource = z.infer<typeof sourceSchema>;
const inventoryStatuses = ['NORMAL', 'UNLIST', 'BANNED', 'REVIEWING'] as const;
const envelopeSchema = z.record(z.string(), z.unknown());
const inventoryScanSchema = z
  .object({
    environment: z.literal('production'),
    partnerId: z.literal('2010476'),
    shopId: z.literal('1423724897'),
    connectionRevision: revision,
    observedAt: z.iso.datetime(),
    requestIds: z.array(z.string().min(1).max(256)).min(4).max(10000),
    pages: z
      .array(
        z
          .object({
            request: z
              .object({
                offset: z.number().int().nonnegative(),
                page_size: z.number().int().min(1).max(100),
                item_status: z.enum(inventoryStatuses),
              })
              .strict(),
            envelope: envelopeSchema,
          })
          .strict(),
      )
      .min(4)
      .max(10000),
    baseInfo: z.array(envelopeSchema).max(10000),
    modelLists: z
      .array(
        z.object({ itemId: z.string().regex(/^[1-9]\d*$/), envelope: envelopeSchema }).strict(),
      )
      .max(10000),
  })
  .strict();
export type ProductionPilotInventoryScan = z.infer<typeof inventoryScanSchema>;
const whitelistMessage =
  'Parameter is not match the constraints, . : You are not in the whitelist to add images in description, can only upload plain text';
const whitelistDebug =
  'violated parameter constraints : You are not in the whitelist to add images in description, can only upload plain text';
const forceEnableDebug =
  'Failed to create product : validation: [Rule Type: logistics.channel.force_enable_forbid_disable, Detail: {"code":1326,"msg":"cannot disable a force-enabled channel"}] ';
const maximumSourceIdentities = 3,
  maximumRevisionsPerSource = 3;
const maximumOperations = maximumSourceIdentities * maximumRevisionsPerSource;

function definitiveCreateRejection(payload: Record<string, any>, receipt: Record<string, any>) {
  const envelope = receipt?.envelope;
  if (
    receipt?.kind !== 'rejected' ||
    !envelope ||
    typeof receipt.requestId !== 'string' ||
    !receipt.requestId ||
    envelope.error !== receipt.code ||
    envelope.request_id !== receipt.requestId ||
    envelope.warning !== '' ||
    Object.keys(envelope).some(
      (key) => !['error', 'message', 'debug_message', 'warning', 'request_id'].includes(key),
    )
  )
    return false;
  if (
    receipt.code === 'product.error_param' &&
    envelope.message === whitelistMessage &&
    envelope.debug_message === whitelistDebug
  ) {
    const fields = payload.description_info?.extended_description?.field_list;
    return (
      payload.description_type === 'extended' &&
      Array.isArray(fields) &&
      fields.some(
        (field) =>
          field?.field_type === 'image' &&
          typeof field.image_info?.image_id === 'string' &&
          field.image_info.image_id,
      )
    );
  }
  if (
    receipt.code === 'product.error_busi' &&
    envelope.message === 'Invalid product setting. Please verify.' &&
    envelope.debug_message === forceEnableDebug
  ) {
    // The real API can report this rule for an omitted mandatory channel, not only enabled:false.
    // This signature proves rejection only; it never identifies or enables a channel for a successor.
    const logistics = z
      .array(
        z
          .object({ logistic_id: z.number().int().positive().safe(), enabled: z.boolean() })
          .passthrough(),
      )
      .min(1)
      .safeParse(payload.logistic_info);
    return (
      logistics.success &&
      new Set(logistics.data.map((channel) => channel.logistic_id)).size === logistics.data.length
    );
  }
  return false;
}

/** Complete active-status census, including model SKUs. Raw omissions are accepted only for an
 * explicitly empty final item page, as observed from get_item_list on this production shop. */
function inventoryIdentity(
  scan: ProductionPilotInventoryScan,
  source: { skus: Set<string>; title: string },
) {
  const usedIds: string[] = [];
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return fail('INVENTORY_INCOMPLETE');
    return value as Record<string, unknown>;
  };
  const id = (value: unknown): string => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
    return fail('INVENTORY_INCOMPLETE');
  };
  const response = (envelope: Record<string, unknown>, baseIdentityCensus = false) => {
    // Actual base-info responses can return every identity while channel fee estimates fail.
    // This exception is confined to identity-absence proof, never listing/shipping QC or enumeration.
    const knownShippingEstimateWarning =
      baseIdentityCensus &&
      typeof envelope.warning === 'string' &&
      /^fail to get channel estimated_shipping_fee for channel \[[1-9]\d*\](?:;\nfail to get channel estimated_shipping_fee for channel \[[1-9]\d*\])*$/.test(
        envelope.warning,
      );
    if (
      envelope.error !== '' ||
      (envelope.warning !== undefined &&
        envelope.warning !== '' &&
        !knownShippingEstimateWarning) ||
      typeof envelope.request_id !== 'string' ||
      !envelope.request_id
    )
      return fail('INVENTORY_INCOMPLETE');
    usedIds.push(envelope.request_id);
    return object(envelope.response);
  };
  const text = (value: unknown) =>
    typeof value === 'string' ? value : fail('INVENTORY_INCOMPLETE');
  const compareKey = (value: string) => value.normalize('NFC').trim().toLocaleLowerCase('en-US');
  const keys = new Set([...source.skus].map(compareKey));
  const noSourceSku = (value: string) => {
    if (value && keys.has(compareKey(value))) fail('INVENTORY_SOURCE_FOUND');
  };
  const listed = new Map<string, string>();
  for (const status of inventoryStatuses) {
    const pages = scan.pages.filter((p) => p.request.item_status === status);
    let offset = 0,
      count = 0,
      total: number | undefined;
    if (!pages.length) fail('INVENTORY_INCOMPLETE');
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index]!,
        raw = response(page.envelope);
      if (
        page.request.offset !== offset ||
        typeof raw.total_count !== 'number' ||
        !Number.isSafeInteger(raw.total_count) ||
        raw.total_count < 0 ||
        (total !== undefined && total !== raw.total_count) ||
        typeof raw.has_next_page !== 'boolean'
      )
        fail('INVENTORY_INCOMPLETE');
      total = raw.total_count as number;
      const items =
        raw.item === undefined && total === 0 && raw.has_next_page === false ? [] : raw.item;
      if (!Array.isArray(items) || items.length > page.request.page_size)
        fail('INVENTORY_INCOMPLETE');
      for (const value of items as unknown[]) {
        const item = object(value),
          itemId = id(item.item_id);
        if (item.item_status !== status || listed.has(itemId)) fail('INVENTORY_INCOMPLETE');
        listed.set(itemId, status);
        count++;
      }
      if (raw.has_next_page) {
        if (
          index === pages.length - 1 ||
          !(items as unknown[]).length ||
          typeof raw.next_offset !== 'number' ||
          !Number.isSafeInteger(raw.next_offset) ||
          raw.next_offset <= offset
        )
          fail('INVENTORY_INCOMPLETE');
        offset = raw.next_offset as number;
      } else if (index !== pages.length - 1 || count !== total) fail('INVENTORY_INCOMPLETE');
    }
  }
  const base = new Map<string, Record<string, unknown>>();
  for (const envelope of scan.baseInfo) {
    const raw = response(envelope, true);
    if (!Array.isArray(raw.item_list) || !raw.item_list.length) fail('INVENTORY_INCOMPLETE');
    for (const entry of raw.item_list as unknown[]) {
      const item = object(entry),
        itemId = id(item.item_id);
      if (
        base.has(itemId) ||
        !listed.has(itemId) ||
        listed.get(itemId) !== item.item_status ||
        typeof item.has_model !== 'boolean'
      )
        fail('INVENTORY_INCOMPLETE');
      const title = text(item.item_name),
        sku = text(item.item_sku);
      if (!title || compareKey(title) === compareKey(source.title)) fail('INVENTORY_SOURCE_FOUND');
      noSourceSku(sku);
      base.set(itemId, item);
    }
  }
  if (base.size !== listed.size) fail('INVENTORY_INCOMPLETE');
  const models = new Map<string, { modelId: string; sku: string }[]>();
  for (const entry of scan.modelLists) {
    const raw = response(entry.envelope),
      item = base.get(entry.itemId);
    if (
      !item ||
      item.has_model !== true ||
      models.has(entry.itemId) ||
      !Array.isArray(raw.model) ||
      !raw.model.length
    )
      fail('INVENTORY_INCOMPLETE');
    const values = (raw.model as unknown[]).map((value) => {
      const model = object(value),
        modelId = id(model.model_id),
        sku = text(model.model_sku);
      noSourceSku(sku);
      return { modelId, sku };
    });
    if (new Set(values.map((v) => v.modelId)).size !== values.length) fail('INVENTORY_INCOMPLETE');
    models.set(
      entry.itemId,
      values.sort((a, b) => a.modelId.localeCompare(b.modelId)),
    );
  }
  for (const [itemId, item] of base)
    if (item.has_model && !models.has(itemId)) fail('INVENTORY_INCOMPLETE');
  if (
    new Set(usedIds).size !== usedIds.length ||
    canonicalJson([...usedIds].sort()) !== canonicalJson([...scan.requestIds].sort())
  )
    fail('INVENTORY_REQUEST_IDS_INVALID');
  return [...base]
    .map(([itemId, item]) => ({
      itemId,
      status: item.item_status,
      sku: item.item_sku,
      title: item.item_name,
      hasModel: item.has_model,
      models: models.get(itemId) ?? [],
    }))
    .sort((a, b) => a.itemId.localeCompare(b.itemId));
}
export type ProductionPilotReadback = {
  shopId: '1423724897';
  partnerId: '2010476';
  itemId: string;
  connectionRevision: number;
  observedAt: string;
  requestIds: string[];
  raw: Record<string, unknown>;
  projection: Record<string, unknown>;
};
export type ProductionPilotOutcome =
  | {
      kind: 'success';
      response: Record<string, unknown>;
      requestId: string;
      envelope?: Record<string, unknown>;
    }
  | {
      kind: 'rejected' | 'unknown';
      code: string;
      requestId?: string;
      envelope?: Record<string, unknown>;
    };

/** Server-only journal, with no network calls or HTTP writer route. The server supplies an explicit
 * source allowlist and truthful full-field projections; an HTTP caller must never provide these.
 * This module proves durable dispatch and evidence comparison, not independent image/semantic QC.
 */
export class ProductionPilotJournal {
  private readonly allowed: ProductionPilotSource[];
  private readonly batchAuthorization?: ProductionPilotBatchAuthorization;
  private readonly executionPolicy?:ExecutionPolicyReceipt;
  constructor(
    readonly repo: Repository,
    options: { allowedSources: readonly ProductionPilotSource[]; batchAuthorization?: ProductionPilotBatchAuthorization;executionPolicy?:ExecutionPolicyReceipt },
  ) {
    this.allowed = z
      .array(sourceSchema)
      .min(1)
      .max(maximumOperations)
      .parse(options.allowedSources);
    this.batchAuthorization = parseProductionPilotBatchAuthorization(options.batchAuthorization, this.allowed);
    this.executionPolicy=options.executionPolicy;
    const identities = new Set(this.allowed.map((source) => source.sourceIdentity));
    if (
      new Set(this.allowed.map((s) => canonicalJson(s))).size !== this.allowed.length ||
      identities.size > (this.batchAuthorization?.sources.length ?? maximumSourceIdentities) ||
      [...identities].some(
        (identity) =>
          this.allowed.filter((source) => source.sourceIdentity === identity).length >
          maximumRevisionsPerSource,
      )
    )
      fail('SOURCE_ALLOWLIST_INVALID');
  }
  private allowedSource(identity: string, sourceRevision: number) {
    if (
      !this.allowed.some(
        (s) => s.sourceIdentity === identity && s.sourceRevision === sourceRevision,
      )
    )
      fail('SOURCE_FORBIDDEN');
  }
  private async lock(c: PoolClient) {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'production-pilot:' + owner,
    ]);
  }
  private async closedAncestry(
    c: PoolClient,
    previous: Record<string, any>[],
    connectionId: string,
  ) {
    // The caller holds the shop advisory lock and all predecessor rows, ordered newest first.
    for (let index = 0; index < previous.length; index++) {
      const op = previous[index]!,
        older = previous[index + 1];
      this.allowedSource(op.source_identity, op.source_revision);
      if (
        op.connection_id !== connectionId ||
        op.state !== 'rejected' ||
        op.item_id !== null ||
        op.supersedes_operation_id !== (older?.id ?? null) ||
        (op.source_payload.supersedesOperationId ?? null) !== op.supersedes_operation_id ||
        (older &&
          (op.source_revision <= older.source_revision ||
            op.source_payload.supersedesOperationId !== older.id))
      )
        fail('SUPERSESSION_UNPROVEN');
      const proof = (
        await c.query('SELECT * FROM production_pilot_rejection_closures WHERE operation_id=$1', [
          op.id,
        ])
      ).rows[0];
      const steps = (
        await c.query(
          'SELECT * FROM production_pilot_steps WHERE operation_id=$1 ORDER BY ordinal FOR UPDATE',
          [op.id],
        )
      ).rows;
      const create = steps.find((step) => step.kind === 'create');
      if (
        !proof ||
        !create ||
        proof.operation_revision !== op.revision ||
        proof.source_fingerprint !== op.source_fingerprint ||
        proof.rejected_step_id !== create.id ||
        create.state !== 'rejected' ||
        create.path !== pathFor.create ||
        steps.some(
          (step) =>
            step.id !== create.id && (step.kind !== 'media' || step.state !== 'acknowledged'),
        ) ||
        !definitiveCreateRejection(create.payload, create.receipt) ||
        create.fingerprint !== proof.rejected_request_fingerprint ||
        create.outcome_fingerprint !== proof.rejected_receipt_fingerprint ||
        canonicalJson(create.payload) !== canonicalJson(proof.rejected_request) ||
        canonicalJson(create.receipt) !== canonicalJson(proof.rejected_receipt)
      )
        fail('SUPERSESSION_UNPROVEN');
    }
  }
  private async connection(c: PoolClient, id: string, expectedRevision?: number) {
    const row = (
      await c.query(
        'SELECT id,environment,partner_id,shop_id,state,revision,expires_at FROM connections WHERE id=$1 FOR SHARE',
        [id],
      )
    ).rows[0];
    if (
      !row ||
      row.environment !== scope.environment ||
      row.partner_id !== scope.partnerId ||
      row.shop_id !== scope.shopId
    )
      fail('SCOPE_FORBIDDEN');
    if (expectedRevision !== undefined && row.revision !== expectedRevision)
      fail('CONNECTION_CHANGED');
    if (
      expectedRevision !== undefined &&
      (row.state !== 'connected' ||
        !row.expires_at ||
        new Date(row.expires_at).getTime() <= Date.now())
    )
      fail('AUTH_REQUIRED');
    return row;
  }
  private async operation(c: PoolClient, id: string, expectedRevision?: number) {
    const row = (
      await c.query('SELECT * FROM production_pilot_operations WHERE id=$1 FOR UPDATE', [
        uuid.parse(id),
      ])
    ).rows[0];
    if (!row || row.owner_key !== owner) return fail('OPERATION_NOT_FOUND');
    this.allowedSource(row.source_identity, row.source_revision);
    assertProductionPilotBatchBinding(this.batchAuthorization, row);
    if (expectedRevision !== undefined && row.revision !== expectedRevision)
      fail('REVISION_CONFLICT');
    await this.connection(c, row.connection_id);
    return row;
  }
  private async parkCompletedWrites(c: PoolClient, operationId: string): Promise<boolean> {
    const eligible=(await c.query('SELECT production_pilot_can_wait_for_qc($1) AS eligible',[operationId])).rows[0]?.eligible;
    if (!eligible) return false;
    await c.query(`INSERT INTO production_pilot_qc_wait_receipts(operation_id,operation_revision,source_fingerprint,item_id)
      SELECT id,revision,source_fingerprint,item_id FROM production_pilot_operations WHERE id=$1 AND owner_key=$2
      ON CONFLICT(operation_id) DO NOTHING`,[operationId,owner]);
    await c.query('DELETE FROM production_pilot_lanes WHERE owner_key=$1 AND operation_id=$2',[owner,operationId]);
    return true;
  }
  async waitForQc(operationId: string): Promise<boolean> {
    return transaction(this.repo.pool,async c=>{
      await this.lock(c);
      await this.operation(c,operationId);
      return this.parkCompletedWrites(c,operationId);
    });
  }
  private async lane(c: PoolClient, operationId: string) {
    const row = (
      await c.query(
        'SELECT operation_id FROM production_pilot_lanes WHERE owner_key=$1 FOR UPDATE',
        [owner],
      )
    ).rows[0];
    if (row && row.operation_id !== operationId) {
      if (!await this.parkCompletedWrites(c,row.operation_id)) fail('SHOP_BUSY');
      await c.query('INSERT INTO production_pilot_lanes(owner_key,operation_id) VALUES($1,$2)',[owner,operationId]);
      return;
    }
    if (!row)
      await c.query('INSERT INTO production_pilot_lanes(owner_key,operation_id) VALUES($1,$2)', [
        owner,
        operationId,
      ]);
  }
  private async view(c: Pick<PoolClient, 'query'>, id: string) {
    const operation = (await c.query('SELECT * FROM production_pilot_operations WHERE id=$1', [id]))
      .rows[0];
    const steps = (
      await c.query('SELECT * FROM production_pilot_steps WHERE operation_id=$1 ORDER BY ordinal', [
        id,
      ])
    ).rows;
    const verification =
      (await c.query('SELECT * FROM production_pilot_verifications WHERE operation_id=$1', [id]))
        .rows[0] ?? null;
    const rejectionClosure =
      (
        await c.query('SELECT * FROM production_pilot_rejection_closures WHERE operation_id=$1', [
          id,
        ])
      ).rows[0] ?? null;
    const deferredImageVerification=(await c.query('SELECT * FROM production_pilot_deferred_image_verifications WHERE operation_id=$1',[id])).rows[0] ?? null;
    return { operation, steps, verification, rejectionClosure, deferredImageVerification };
  }
  async get(id: string) {
    return transaction(this.repo.pool, async (c) => {
      await this.lock(c);
      await this.operation(c, id);
      return this.view(c, id);
    });
  }
  private async renewal(c: Pick<PoolClient, 'query'>, op: Record<string, any>, renewalId?: string) {
    const receipt = (await c.query(
      'SELECT * FROM production_pilot_preflight_renewals WHERE operation_id=$1 ORDER BY ordinal DESC LIMIT 1', [op.id],
    )).rows[0] ?? null;
    if ((receipt?.id ?? undefined) !== renewalId) fail('PREFLIGHT_RENEWAL_CHANGED');
    if (receipt && (receipt.source_fingerprint !== op.source_fingerprint ||
      canonicalJson(receipt.expected_projection) !== canonicalJson(op.expected_projection) ||
      receipt.receipt_fingerprint !== fingerprint({ operationId: op.id,
        sourceFingerprint: receipt.source_fingerprint, sourcePayload: receipt.source_payload,
        expectedProjection: receipt.expected_projection }))) fail('PREFLIGHT_RENEWAL_INVALID');
    return receipt;
  }
  async getPreflightRenewal(operationId: string) {
    return transaction(this.repo.pool, async c => {
      await this.lock(c);
      const op = await this.operation(c, operationId);
      const latest = (await c.query('SELECT id FROM production_pilot_preflight_renewals WHERE operation_id=$1 ORDER BY ordinal DESC LIMIT 1', [op.id])).rows[0];
      return this.renewal(c, op, latest?.id);
    });
  }
  /** Internal runner only: fresh proofs supplement an untouched intent, never replace it. */
  async renewUndispatched(input: { operationId: string; expectedSourceFingerprint: string;
    sourcePayload: Record<string, unknown>; expectedProjection: Record<string, unknown> }) {
    const source = snapshot(input.sourcePayload), projection = snapshot(input.expectedProjection);
    return transaction(this.repo.pool, async c => {
      await this.lock(c);
      const op = await this.operation(c, input.operationId, 1);
      const view = await this.view(c, op.id);
      if (op.state !== 'authorized' || op.item_id !== null || view.steps.length ||
        view.verification || view.rejectionClosure || view.deferredImageVerification ||
        op.source_fingerprint !== input.expectedSourceFingerprint) fail('PREFLIGHT_RENEWAL_FORBIDDEN');
      if (fingerprint({ scope, sourceIdentity: op.source_identity, sourceRevision: op.source_revision,
        sourcePayload: op.source_payload, expectedProjection: op.expected_projection }) !== op.source_fingerprint)
        fail('PREFLIGHT_RENEWAL_INVALID');
      for (const key of ['sourceIdentity', 'sourceRevision', 'connectionId', 'document', 'assets', 'issues', 'supersedesOperationId'])
        if (canonicalJson(source[key] ?? null) !== canonicalJson(op.source_payload[key] ?? null)) fail('PREFLIGHT_SOURCE_CHANGED');
      if (source.connectionId !== op.connection_id || source.sourceIdentity !== op.source_identity ||
        source.sourceRevision !== op.source_revision || canonicalJson(projection) !== canonicalJson(op.expected_projection))
        fail('PREFLIGHT_SOURCE_CHANGED');
      if (op.source_payload.batchAuthorization) source.batchAuthorization = snapshot(op.source_payload.batchAuthorization);
      else if (Object.hasOwn(source, 'batchAuthorization')) fail('PREFLIGHT_SOURCE_CHANGED');
      const meta = source.metadata as Record<string, any>;
      if (!meta || meta.environment !== scope.environment || meta.partnerId !== scope.partnerId || meta.shopId !== scope.shopId ||
        meta.connectionRevision !== source.connectionRevision || meta.categoryId !== (source.document as any)?.categoryId ||
        !z.iso.datetime().safeParse(meta.observedAt).success || !z.iso.datetime().safeParse(meta.expiresAt).success ||
        Date.parse(meta.observedAt) > Date.now() || Date.parse(meta.expiresAt) <= Date.now() ||
        Date.parse(meta.expiresAt) <= Date.parse(meta.observedAt) || Date.parse(meta.expiresAt)-Date.parse(meta.observedAt)>900000 ||
        !Array.isArray(meta.requestIds) || !meta.requestIds.length || meta.requestIds.some((id: unknown) => typeof id !== 'string' || !id))
        fail('PREFLIGHT_METADATA_INVALID');
      await this.connection(c, op.connection_id, revision.parse(source.connectionRevision));
      const id = randomUUID(), receiptFingerprint = fingerprint({ operationId: op.id,
        sourceFingerprint: op.source_fingerprint, sourcePayload: source, expectedProjection: projection });
      await c.query(`INSERT INTO production_pilot_preflight_renewals(id,operation_id,ordinal,source_fingerprint,source_payload,expected_projection,receipt_fingerprint)
        SELECT $1,$2,COALESCE(max(ordinal),0)+1,$3,$4,$5,$6 FROM production_pilot_preflight_renewals WHERE operation_id=$2`,
        [id, op.id, op.source_fingerprint, source, projection, receiptFingerprint]);
      return { renewalId: id };
    });
  }
  /** Trusted server collector only. Closing the lane never rewrites the original rejected attempt. */
  async closeRejectedCreate(input: {
    operationId: string;
    expectedRevision: number;
    connectionRevision: number;
    scans: readonly ProductionPilotInventoryScan[];
  }) {
    revision.parse(input.expectedRevision);
    revision.parse(input.connectionRevision);
    const scans = z
      .array(inventoryScanSchema)
      .length(2)
      // Two complete item/model censuses have a larger bounded budget than a write payload.
      // The16MB byte cap and all depth, accessor, array and secret checks remain identical.
      .parse(snapshot({ scans: input.scans }, 500000).scans);
    return transaction(this.repo.pool, async (c) => {
      await this.lock(c);
      const op = await this.operation(c, input.operationId, input.expectedRevision);
      await this.connection(c, op.connection_id, input.connectionRevision);
      const steps = (
        await c.query(
          'SELECT * FROM production_pilot_steps WHERE operation_id=$1 ORDER BY ordinal FOR UPDATE',
          [op.id],
        )
      ).rows;
      const create = steps.find((s) => s.kind === 'create');
      if (
        op.state !== 'rejected' ||
        op.item_id !== null ||
        !create ||
        create.state !== 'rejected' ||
        create.path !== pathFor.create ||
        steps.some(
          (s) => s.id !== create.id && (s.kind !== 'media' || s.state !== 'acknowledged'),
        ) ||
        (
          await c.query(
            'SELECT 1 FROM production_pilot_publications WHERE create_operation_id=$1',
            [op.id],
          )
        ).rowCount
      )
        fail('REJECTION_CLOSURE_FORBIDDEN');
      const receipt = create.receipt;
      if (
        !definitiveCreateRejection(create.payload, receipt) ||
        create.outcome_fingerprint !== fingerprint(receipt) ||
        create.fingerprint !== productionPilotWriteFingerprint(pathFor.create, create.payload)
      )
        fail('REJECTION_NOT_DEFINITIVE');
      const evidenceHash = fingerprint({
        operationId: op.id,
        operationRevision: op.revision,
        sourceFingerprint: op.source_fingerprint,
        rejectedStepId: create.id,
        requestFingerprint: create.fingerprint,
        receiptFingerprint: create.outcome_fingerprint,
        connectionRevision: input.connectionRevision,
        scans,
      });
      const existing = (
        await c.query('SELECT * FROM production_pilot_rejection_closures WHERE operation_id=$1', [
          op.id,
        ])
      ).rows[0];
      if (existing) {
        if (existing.evidence_fingerprint !== evidenceHash) fail('REJECTION_CLOSURE_CONFLICT');
        return this.view(c, op.id);
      }
      const times = scans.map((s) => Date.parse(s.observedAt)),
        now = Date.now();
      if (
        !(
          times[0]! > new Date(create.recorded_at).getTime() &&
          times[1]! > times[0]! &&
          times[1]! <= now
        ) ||
        scans.some(
          (s) =>
            s.connectionRevision !== input.connectionRevision ||
            now - Date.parse(s.observedAt) > 15 * 60_000,
        ) ||
        new Set(scans.flatMap((s) => s.requestIds)).size !==
          scans.reduce((count, s) => count + s.requestIds.length, 0) ||
        scans.some((s) => s.requestIds.includes(receipt.requestId))
      )
        fail('INVENTORY_SCOPE_INVALID');
      const doc = z
        .object({
          sourceKey: z.string().min(1),
          title: z.string().min(1),
          models: z.array(z.object({ sku: z.string().min(1) })).min(1),
        })
        .parse(op.source_payload.document);
      if (
        create.payload.item_sku !== doc.sourceKey ||
        create.payload.item_name !== doc.title ||
        create.payload.item_status !== 'UNLIST' ||
        Object.hasOwn(create.payload, 'item_id')
      )
        fail('REJECTION_SOURCE_INVALID');
      const identity = {
        skus: new Set([doc.sourceKey, ...doc.models.map((m) => m.sku)]),
        title: doc.title,
      };
      const inventories = scans.map((s) => inventoryIdentity(s, identity));
      if (canonicalJson(inventories[0]) !== canonicalJson(inventories[1]))
        fail('INVENTORY_UNSTABLE');
      const lane = (
        await c.query('SELECT * FROM production_pilot_lanes WHERE owner_key=$1 FOR UPDATE', [owner])
      ).rows[0];
      if (!lane || lane.operation_id !== op.id) fail('SHOP_OWNER_MISMATCH');
      await c.query(
        `INSERT INTO production_pilot_rejection_closures(id,operation_id,operation_revision,source_fingerprint,
        rejected_step_id,rejected_request_fingerprint,rejected_receipt_fingerprint,rejected_request,rejected_receipt,
        connection_revision,scans,evidence_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          randomUUID(),
          op.id,
          op.revision,
          op.source_fingerprint,
          create.id,
          create.fingerprint,
          create.outcome_fingerprint,
          create.payload,
          receipt,
          input.connectionRevision,
          JSON.stringify(scans),
          evidenceHash,
        ],
      );
      await c.query('DELETE FROM production_pilot_lanes WHERE owner_key=$1 AND operation_id=$2', [
        owner,
        op.id,
      ]);
      return this.view(c, op.id);
    });
  }
  async authorizeOperation(
    raw: ProductionPilotSource & {
      connectionId: string;
      expectedConnectionRevision: number;
      sourcePayload: Record<string, unknown>;
      expectedProjection: Record<string, unknown>;
      supersedesOperationId?: string;
    },
  ) {
    const input = z
      .object({
        ...sourceSchema.shape,
        connectionId: uuid,
        expectedConnectionRevision: revision,
        sourcePayload: z.record(z.string(), z.unknown()),
        expectedProjection: z.record(z.string(), z.unknown()),
        supersedesOperationId: uuid.optional(),
      })
      .strict()
      .parse(raw);
    this.allowedSource(input.sourceIdentity, input.sourceRevision);
    const source = snapshot(input.sourcePayload),
      projection = snapshot(input.expectedProjection);
    bindProductionPilotBatchAuthorization(this.batchAuthorization, input, source);
    if (
      Object.hasOwn(source, 'supersedesOperationId') &&
      source.supersedesOperationId !== input.supersedesOperationId
    )
      fail('SUPERSESSION_UNPROVEN');
    if (input.supersedesOperationId) source.supersedesOperationId = input.supersedesOperationId;
    if (!Object.keys(source).length || !Object.keys(projection).length) fail('INVALID_SNAPSHOT');
    const sourceFingerprint = fingerprint({
      scope,
      sourceIdentity: input.sourceIdentity,
      sourceRevision: input.sourceRevision,
      sourcePayload: source,
      expectedProjection: projection,
    });
    return transaction(this.repo.pool, async (c) => {
      await this.lock(c);
      await this.connection(c, input.connectionId, input.expectedConnectionRevision);
      // The owner lock serializes the first batch reservation and every subsequent identity.
      // Existing immutable operation payloads are the authorization record; no migration or
      // rewrite of prior pilot rows is necessary. A batch ID can never bind a different proof.
      const batchRows = this.batchAuthorization ? (await c.query(
        `SELECT * FROM production_pilot_operations WHERE owner_key=$1
         AND source_payload->'batchAuthorization'->>'batchId'=$2 FOR UPDATE`,
        [owner, this.batchAuthorization.batchId],
      )).rows : undefined;
      for (const row of batchRows ?? []) assertProductionPilotBatchBinding(this.batchAuthorization, row);
      const previous = (
        await c.query(
          'SELECT * FROM production_pilot_operations WHERE owner_key=$1 AND source_identity=$2 ORDER BY source_revision DESC FOR UPDATE',
          [owner, input.sourceIdentity],
        )
      ).rows;
      for (const row of previous) assertProductionPilotBatchBinding(this.batchAuthorization, row);
      const old = previous.find((row) => row.source_revision === input.sourceRevision);
      if (old) {
        if (
          old.source_revision !== input.sourceRevision ||
          old.source_fingerprint !== sourceFingerprint ||
          old.connection_id !== input.connectionId ||
          old.supersedes_operation_id !== (input.supersedesOperationId ?? null)
        )
          fail('SOURCE_ALREADY_RESERVED');
        return this.view(c, old.id);
      }
      if (previous.length) {
        const superseded = previous[0]!;
        if (!input.supersedesOperationId) fail('SOURCE_ALREADY_RESERVED');
        if (
          superseded.id !== input.supersedesOperationId ||
          superseded.source_revision >= input.sourceRevision ||
          superseded.connection_id !== input.connectionId ||
          superseded.state !== 'rejected' ||
          superseded.item_id !== null
        )
          fail('SUPERSESSION_UNPROVEN');
        await this.closedAncestry(c, previous, input.connectionId);
      } else if (input.supersedesOperationId) fail('SUPERSESSION_UNPROVEN');
      const occupied = (await c.query('SELECT operation_id FROM production_pilot_lanes WHERE owner_key=$1 FOR UPDATE', [owner])).rows[0];
      if (occupied && !await this.parkCompletedWrites(c,occupied.operation_id)) fail('SHOP_BUSY');
      const counts = batchRows ? { total: batchRows.length, identities: new Set(batchRows.map(row => row.source_identity)).size } : (
        await c.query(
          `SELECT count(*) AS total,count(DISTINCT source_identity) AS identities FROM production_pilot_operations
           WHERE owner_key=$1 AND NOT (source_payload ? 'batchAuthorization')`,
          [owner],
        )
      ).rows[0];
      if (
        Number(counts.total) >= (this.batchAuthorization?.sources.length ?? maximumOperations) ||
        previous.length >= maximumRevisionsPerSource ||
        (!previous.length && Number(counts.identities) >= (this.batchAuthorization?.sources.length ?? maximumSourceIdentities))
      )
        fail('BATCH_LIMIT');
      const id = randomUUID();
      await c.query(
        `INSERT INTO production_pilot_operations(id,owner_key,connection_id,connection_revision,source_identity,source_revision,source_payload,source_fingerprint,expected_projection,state,supersedes_operation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'authorized',$10)`,
        [
          id,
          owner,
          input.connectionId,
          input.expectedConnectionRevision,
          input.sourceIdentity,
          input.sourceRevision,
          source,
          sourceFingerprint,
          projection,
          input.supersedesOperationId ?? null,
        ],
      );
      return this.view(c, id);
    });
  }
  private async authorizeStep(
    input: { operationId: string; expectedRevision: number; stepKey: string; renewalId?: string },
    kind: 'media' | 'create' | 'variations',
    path: string,
    payload: Record<string, unknown>,
    media: Record<string, unknown> | null,
    hash: string,
  ) {
    uuid.parse(input.operationId);
    revision.parse(input.expectedRevision);
    stepKey.parse(input.stepKey);
    return transaction(this.repo.pool, async (c) => {
      await this.lock(c);
      const op = await this.operation(c, input.operationId, input.expectedRevision);
      const renewal = await this.renewal(c, op, input.renewalId);
      await this.connection(c, op.connection_id, renewal?.source_payload.connectionRevision ?? op.connection_revision);
      const steps = (
        await c.query(
          'SELECT * FROM production_pilot_steps WHERE operation_id=$1 ORDER BY ordinal FOR UPDATE',
          [op.id],
        )
      ).rows;
      const old = steps.find((s) => s.step_key === input.stepKey);
      if (old) {
        if (
          old.kind !== kind ||
          old.fingerprint !== hash ||
          canonicalJson(old.media) !== canonicalJson(media)
        )
          fail('STEP_CONFLICT');
        return { ...(await this.view(c, op.id)), step: old };
      }
      if (
        !['authorized', 'acknowledged'].includes(op.state) ||
        steps.some((s) => s.state !== 'acknowledged')
      )
        fail('RECONCILIATION_REQUIRED');
      if (kind === 'media' && steps.some((s) => s.kind !== 'media')) fail('STEP_ORDER_INVALID');
      if (
        kind === 'create' &&
        (steps.some((s) => s.kind === 'create') ||
          payload.item_status !== 'UNLIST' ||
          Object.hasOwn(payload, 'item_id'))
      )
        fail('CREATE_FORBIDDEN');
      if (
        kind === 'variations' &&
        (!op.item_id ||
          String(payload.item_id) !== op.item_id ||
          steps.some((s) => s.kind === 'variations'))
      )
        fail('ITEM_MISMATCH');
      await this.lane(c, op.id);
      const next = op.revision + 1,
        id = randomUUID();
      await c.query(
        `INSERT INTO production_pilot_steps(id,operation_id,step_key,ordinal,kind,path,payload,media,fingerprint,authorized_revision,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'authorized')`,
        [id, op.id, input.stepKey, steps.length + 1, kind, path, payload, media, hash, next],
      );
      await c.query(
        "UPDATE production_pilot_operations SET revision=revision+1,state='authorized',updated_at=now() WHERE id=$1 AND revision=$2",
        [op.id, op.revision],
      );
      const view = await this.view(c, op.id);
      return { ...view, step: view.steps.find((s) => s.id === id)! };
    });
  }
  async authorizeWrite(input: {
    operationId: string;
    renewalId?: string;
    expectedRevision: number;
    stepKey: string;
    kind: 'create' | 'variations';
    payload: Record<string, unknown>;
  }) {
    const kind = z.enum(['create', 'variations']).parse(input.kind),
      payload = snapshot(input.payload),
      path = pathFor[kind];
    if (['shop_id', 'partner_id', 'timestamp', 'sign'].some((key) => Object.hasOwn(payload, key)))
      fail('SCOPE_FORBIDDEN');
    return this.authorizeStep(
      input,
      kind,
      path,
      payload,
      null,
      productionPilotWriteFingerprint(path, payload),
    );
  }
  async authorizeMedia(input: {
    operationId: string;
    renewalId?: string;
    expectedRevision: number;
    stepKey: string;
    sourceAssetIdentity: string;
    bytes: Uint8Array;
    mime: 'image/png' | 'image/jpeg';
    options: ProductionPilotImageOptions;
  }) {
    z.string().min(1).max(300).parse(input.sourceAssetIdentity);
    const bytes = Uint8Array.from(input.bytes),
      options = { ...input.options };
    const hash = productionPilotUploadFingerprint(bytes, input.mime, options);
    const media = {
      sourceAssetIdentity: input.sourceAssetIdentity,
      sha256: sha(bytes),
      bytes: bytes.byteLength,
      mime: input.mime,
      ...options,
    };
    return this.authorizeStep(input, 'media', '/api/v2/media_space/upload_image', {}, media, hash);
  }
  /** Pass directly as transport authorizeMutation. Commit 'sent' BEFORE permitting the network call.
   * False is terminal for this permit; neither process restart nor timeout makes it reusable. */
  async markSent(intent: Readonly<ProductionPilotMutationIntent>, renewalId?: string): Promise<boolean> {
    uuid.parse(intent.operationId);
    uuid.parse(intent.stepId);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(intent.fingerprint);
    return transaction(this.repo.pool, async (c) => {
      await this.lock(c);
      const op = await this.operation(c, intent.operationId);
      const renewal = await this.renewal(c, op, renewalId);
      await this.connection(c, op.connection_id, renewal?.source_payload.connectionRevision ?? op.connection_revision);
      const step = (
        await c.query(
          'SELECT * FROM production_pilot_steps WHERE operation_id=$1 AND id=$2 FOR UPDATE',
          [op.id, intent.stepId],
        )
      ).rows[0];
      if (
        !step ||
        step.state !== 'authorized' ||
        step.authorized_revision !== op.revision ||
        op.state !== 'authorized' ||
        step.path !== intent.path ||
        step.fingerprint !== intent.fingerprint
      )
        return false;
      await this.lane(c, op.id);
      // Check the immutable source deadline after every lock wait. A caller-side check before
      // this transaction cannot authorize dispatch once metadata expires while the shop is busy.
      const deadline = z.iso.datetime().safeParse((renewal?.source_payload ?? op.source_payload)?.metadata?.expiresAt);
      const sentAt = Date.now();
      if (!deadline.success || Date.parse(deadline.data) <= sentAt) return false;
      await c.query(
        "UPDATE production_pilot_steps SET state='sent',sent_at=$2 WHERE id=$1 AND state='authorized'",
        [step.id, new Date(sentAt)],
      );
      await c.query(
        "UPDATE production_pilot_operations SET state='sent',revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$2",
        [op.id, op.revision],
      );
      return true;
    });
  }
  /** Recording an already-sent receipt stays possible after credential rotation; it never permits a new write. */
  async recordOutcome(input: {
    operationId: string;
    stepId: string;
    expectedRevision: number;
    result: ProductionPilotOutcome;
  }) {
    uuid.parse(input.stepId);
    revision.parse(input.expectedRevision);
    const result = snapshot(input.result);
    z.enum(['success', 'rejected', 'unknown']).parse(result.kind);
    if (result.kind === 'success') z.string().min(1).max(256).parse(result.requestId);
    else z.string().min(1).max(200).parse(result.code);
    const outcomeHash = fingerprint(result);
    return transaction(this.repo.pool, async (c) => {
      await this.lock(c);
      const op = await this.operation(c, input.operationId);
      const step = (
        await c.query(
          'SELECT * FROM production_pilot_steps WHERE operation_id=$1 AND id=$2 FOR UPDATE',
          [op.id, input.stepId],
        )
      ).rows[0];
      if (!step) fail('STEP_NOT_FOUND');
      if (step.outcome_fingerprint === outcomeHash) return this.view(c, op.id);
      if (op.revision !== input.expectedRevision) fail('REVISION_CONFLICT');
      if (step.state !== 'sent' || op.state !== 'sent') fail('REPLAY_FORBIDDEN');
      let state = result.kind === 'success' ? 'acknowledged' : result.kind;
      let itemId: string | null = op.item_id;
      if (state === 'acknowledged' && step.kind === 'create') {
        const candidate = (result.response as Record<string, unknown> | undefined)?.item_id;
        if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate <= 0)
          state = 'unknown';
        else itemId = String(candidate);
      }
      await c.query(
        'UPDATE production_pilot_steps SET state=$2,receipt=$3,outcome_fingerprint=$4,recorded_at=$5 WHERE id=$1',
        [step.id, state, result, outcomeHash, new Date()],
      );
      await c.query(
        'UPDATE production_pilot_operations SET state=$2,item_id=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$4',
        [op.id, state, itemId, op.revision],
      );
      // Keep lane on acknowledgement, rejection and uncertainty; partial listings need readback.
      return this.view(c, op.id);
    });
  }
  async recordVerification(input: {
    operationId: string;
    expectedRevision: number;
    phase: 'created_unlisted';
    readbacks: readonly ProductionPilotReadback[];
    deferImageQc?: boolean;
  }) {
    z.literal('created_unlisted').parse(input.phase);
    revision.parse(input.expectedRevision);
    const reads = z
      .array(
        z
          .object({
            shopId: z.literal('1423724897'),
            partnerId: z.literal('2010476'),
            itemId: z.string().regex(/^[1-9]\d*$/),
            connectionRevision: revision,
            observedAt: z.iso.datetime(),
            requestIds: z.array(z.string().min(1).max(256)).min(1).max(10),
            raw: z.record(z.string(), z.unknown()),
            projection: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .length(2)
      .parse(input.readbacks)
      .map((read) => ({ ...read, raw: snapshot(read.raw), projection: snapshot(read.projection) }));
    return transaction(this.repo.pool, async (c) => {
      await this.lock(c);
      const op = await this.operation(c, input.operationId, input.expectedRevision);
      const deferred=input.deferImageQc===true;
      if(deferred && !this.executionPolicy && (this.batchAuthorization?.imageQcPolicy!=='defer_image_qc'||this.batchAuthorization.publicationMode!=='hidden_for_review'))fail('IMAGE_DEFERRAL_FORBIDDEN');
      if(deferred && this.executionPolicy) {
        const saved=(await c.query('SELECT body,fingerprint FROM production_execution_policies WHERE id=$1',[this.executionPolicy.id])).rows[0];
        if(!saved || saved.fingerprint!==this.executionPolicy.fingerprint || canonicalJson({...saved.body,fingerprint:saved.fingerprint})!==canonicalJson(this.executionPolicy))fail('IMAGE_DEFERRAL_FORBIDDEN');
      }
      const connection = await this.connection(c, op.connection_id, reads[0]!.connectionRevision);
      const steps = (
        await c.query(
          'SELECT * FROM production_pilot_steps WHERE operation_id=$1 ORDER BY ordinal',
          [op.id],
        )
      ).rows;
      if (
        !op.item_id ||
        !steps.some((s) => s.kind === 'create' && s.state === 'acknowledged') ||
        steps.some(
          (s) =>
            ['authorized', 'sent'].includes(s.state) ||
            (s.kind === 'media' && s.state !== 'acknowledged'),
        ) ||
        op.state === 'verified' || (deferred && (op.state!=='acknowledged'||steps.some(s=>s.state!=='acknowledged')))
      )
        fail('RECONCILIATION_REQUIRED');
      const lastAcknowledgement = Math.max(
        ...steps.map((s) => new Date(s.recorded_at ?? s.sent_at).getTime()),
      );
      const t1 = Date.parse(reads[0]!.observedAt),
        t2 = Date.parse(reads[1]!.observedAt);
      if (
        !(t1 > lastAcknowledgement && t2 > t1 && t2 <= Date.now()) ||
        reads.some(
          (r) =>
            r.itemId !== op.item_id ||
            r.connectionRevision !== connection.revision ||
            !Object.keys(r.raw).length,
        )
      )
        fail('READBACK_SCOPE_INVALID');
      const ids = reads.flatMap((r) => r.requestIds);
      if (
        new Set(ids).size !== ids.length ||
        reads.some((r) => canonicalJson(r.projection) !== canonicalJson(deferred ? coreProjectionWithoutImages(op.expected_projection) : op.expected_projection))
      )
        fail('READBACK_MISMATCH');
      const savedReads = reads.map((r) => ({
        ...r,
        rawSha256: fingerprint(r.raw),
        projectionSha256: fingerprint(r.projection),
      }));
      if(deferred) {
        const receipt={operation_id:op.id,operation_revision:op.revision,item_id:op.item_id,source_fingerprint:op.source_fingerprint,
          ...(this.executionPolicy ? {execution_policy_id:this.executionPolicy.id} : {}),
          basis:'image_qc_deferred_by_operator',expected_core_fingerprint:fingerprint(coreProjectionWithoutImages(op.expected_projection)),
          readbacks:savedReads,evidence_fingerprint:fingerprint(savedReads)};
        assertDeferredImageVerification(receipt,op,this.executionPolicy);
        const lane=(await c.query('SELECT operation_id FROM production_pilot_lanes WHERE owner_key=$1 FOR UPDATE',[owner])).rows[0];
        if(!lane || lane.operation_id!==op.id) {
          const parked=(await c.query('SELECT 1 FROM production_pilot_qc_wait_receipts WHERE operation_id=$1 AND operation_revision=$2 AND source_fingerprint=$3',[op.id,op.revision,op.source_fingerprint])).rows.length===1;
          if(!parked || !(await c.query('SELECT production_pilot_can_wait_for_qc($1) AS ok',[op.id])).rows[0]?.ok)fail('SHOP_OWNER_MISMATCH');
        }
        await c.query(`INSERT INTO production_pilot_deferred_image_verifications(operation_id,operation_revision,item_id,source_fingerprint,basis,expected_core_fingerprint,readbacks,evidence_fingerprint,execution_policy_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[op.id,op.revision,op.item_id,op.source_fingerprint,receipt.basis,receipt.expected_core_fingerprint,JSON.stringify(savedReads),receipt.evidence_fingerprint,this.executionPolicy?.id ?? null]);
        await c.query('DELETE FROM production_pilot_lanes WHERE owner_key=$1 AND operation_id=$2',[owner,op.id]);
        return this.view(c,op.id);
      }
      await c.query(
        `INSERT INTO production_pilot_verifications(id,operation_id,operation_revision,phase,item_id,expected_fingerprint,readbacks,evidence_fingerprint)
        VALUES($1,$2,$3,'created_unlisted',$4,$5,$6,$7)`,
        [
          randomUUID(),
          op.id,
          op.revision,
          op.item_id,
          fingerprint(op.expected_projection),
          JSON.stringify(savedReads),
          fingerprint(savedReads),
        ],
      );
      await c.query(
        "UPDATE production_pilot_operations SET state='verified',revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$2",
        [op.id, op.revision],
      );
      await c.query('DELETE FROM production_pilot_lanes WHERE owner_key=$1 AND operation_id=$2', [
        owner,
        op.id,
      ]);
      return this.view(c, op.id);
    });
  }
  // Publication requires a distinct authorized stage and fresh QC; there is deliberately no NORMAL writer here.
}
