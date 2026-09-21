import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalJson,
  type PreparedDocument,
  type PreparedEntry,
  type PreparedField,
  type PreparedGateway,
  type PreparedMetadata,
  type PreparedOutcome,
  type PreparedRemote,
  type Scope,
} from '@shopee/domain';
import { Repository, transaction, type Pool } from '@shopee/persistence';

const fields = [
  'title',
  'description',
  'cover',
  'gallery',
  'variationImages',
  'price',
  'stock',
  'attributes',
  'logistics',
] as const;
const skuFields = new Set<PreparedField>(['price', 'stock', 'variationImages']);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(200);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const mediaSchema = z
  .object({
    importId: z.string().uuid(),
    sha256: digest,
    width: integer.min(1),
    height: integer.min(1),
    mime: z.enum(['image/png', 'image/jpeg']),
  })
  .strict();
const modelSchema = z
  .object({
    sku: identifier,
    optionLabels: z.array(identifier).max(2),
    tierIndex: z.array(integer).max(2),
    originalPrice: z
      .string()
      .regex(/^[1-9]\d*$/)
      .refine((value) => Number.isSafeInteger(Number(value))),
    stock: integer,
    image: mediaSchema.optional(),
    weightGrams: z.number().finite().positive().optional(),
    dimensionCm: z
      .object({ length: integer.min(1), width: integer.min(1), height: integer.min(1) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((model, context) => {
    if (model.dimensionCm !== undefined && model.weightGrams === undefined)
      context.addIssue({
        code: 'custom',
        path: ['weightGrams'],
        message: 'Model dimensions require an explicit model weight',
      });
  });
const documentSchema = z
  .object({
    sourceKey: identifier,
    title: z.string().min(1).max(10000),
    description: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('text'), text: z.string() }).strict(),
          z.object({ type: z.literal('image'), image: mediaSchema }).strict(),
        ]),
      )
      .min(1)
      .max(500),
    cover: mediaSchema,
    gallery: z.array(mediaSchema).min(1).max(100),
    tierNames: z.array(identifier).max(2),
    models: z.array(modelSchema).min(1).max(2000),
    categoryId: identifier,
    brandId: identifier,
    attributes: z.record(z.string(), z.array(z.string()).min(1)),
    logistics: z
      .array(z.object({ channelId: identifier, enabled: z.boolean() }).strict())
      .min(1)
      .max(100),
    weightGrams: z.number().finite().positive(),
    dimensionCm: z
      .object({ length: integer.min(1), width: integer.min(1), height: integer.min(1) })
      .strict(),
    publication: z.literal('unlisted'),
  })
  .strict()
  .superRefine((document, context) => {
    const fail = (message: string) => context.addIssue({ code: 'custom', message });
    if (
      new Set(document.tierNames).size !== document.tierNames.length ||
      new Set(document.models.map((m) => m.sku)).size !== document.models.length ||
      new Set(document.models.map((m) => canonicalJson(m.tierIndex))).size !==
        document.models.length
    )
      fail('Duplicate source identity');
    if (!document.tierNames.length && document.models.length !== 1)
      fail('Untiered source must have exactly one SKU');
    if (
      !document.tierNames.length &&
      document.models.some(
        (model) => model.weightGrams !== undefined || model.dimensionCm !== undefined,
      )
    )
      fail('Untiered source must specify shipping on the item, not model overrides');
    for (const model of document.models)
      if (
        model.optionLabels.length !== document.tierNames.length ||
        model.tierIndex.length !== document.tierNames.length
      )
        fail('Source tier mapping is incomplete');
    for (let tier = 0; tier < document.tierNames.length; tier++) {
      const byIndex = new Map<number, string>(),
        byLabel = new Map<string, number>();
      for (const model of document.models) {
        const index = model.tierIndex[tier]!,
          label = model.optionLabels[tier]!;
        if (
          (byIndex.has(index) && byIndex.get(index) !== label) ||
          (byLabel.has(label) && byLabel.get(label) !== index)
        )
          fail('Source tier mapping is ambiguous');
        byIndex.set(index, label);
        byLabel.set(label, index);
      }
      if ([...byIndex.keys()].sort((a, b) => a - b).some((value, index) => value !== index))
        fail('Source tier indices must be contiguous');
    }
    if (
      new Set(document.logistics.map((channel) => channel.channelId)).size !==
      document.logistics.length
    )
      fail('Duplicate channel');
  });
const scopeSchema = z
  .object({
    environment: z.literal('sandbox'),
    partnerId: identifier,
    shopId: identifier,
    connectionRevision: integer.min(1),
    capabilityRevision: integer,
  })
  .strict();
const entrySchema = z
  .object({
    folderKey: identifier,
    connectionId: z.string().uuid(),
    scope: scopeSchema,
    sourceFingerprint: digest,
    sourceRefs: z
      .array(
        z
          .object({
            fileSha256: z.string().min(1),
            locator: z.string().min(1),
            observedAt: z.string().min(1),
            kind: z.enum(['product_file', 'user_decision', 'official_doc', 'seller_observation']),
          })
          .passthrough(),
      )
      .min(1),
    document: documentSchema,
  })
  .strict();
/** Validate one imported row so a malformed envelope can be reported without losing other rows. */
export function validatePreparedEntry(entry: unknown): PreparedEntry {
  return entrySchema.parse(entry);
}
const inputSchema = z
  .object({
    batchId: z.string().uuid(),
    fingerprint: digest,
    inputSourceDigest: digest,
    entries: z.array(entrySchema).min(1).max(500),
    operation: z.enum(['create', 'update']),
    fieldMask: z.array(z.enum(fields)).max(fields.length),
    selectedSkus: z.array(identifier).max(20000).optional(),
  })
  .strict();
const metadataSchema = z
  .object({
    categoryId: identifier,
    supported: z.boolean(),
    requiredAttributes: z.array(identifier),
    allowedAttributeValues: z.record(z.string(), z.array(z.string())),
    brandIds: z.array(identifier),
    channelIds: z.array(identifier),
    maxGallery: integer.min(1),
    maxModels: integer.min(1),
    minPrice: integer.min(1),
    maxPrice: integer.min(1),
    maxStock: integer,
  })
  .strict();
const remoteSchema = z
  .object({
    itemId: identifier,
    document: documentSchema,
    modelBindings: z.array(
      z
        .object({ sku: identifier, modelId: identifier, tierIndex: z.array(integer).max(2) })
        .strict(),
    ),
    extra: z.record(z.string(), z.unknown()),
  })
  .strict();
export type PreparedExecutionInput = {
  batchId: string;
  fingerprint: string;
  inputSourceDigest: string;
  entries: PreparedEntry[];
  operation: 'create' | 'update';
  fieldMask: PreparedField[];
  selectedSkus?: string[];
};
export type PreparedExecutionJobState =
  'prepared' | 'queued' | 'running' | 'unknown' | 'verified' | 'blocked' | 'cancelled';
export type PreparedExecutionJob = {
  id: string;
  state: PreparedExecutionJobState;
  durableState: PreparedExecutionJobState;
  inFlight: boolean;
  blockedByUnresolvedOwner: boolean;
  paused: boolean;
  mutationSent: boolean;
  entry: PreparedEntry;
  operation: 'create' | 'update';
  fieldMask: PreparedField[];
  selectedSkus: string[];
  itemId: string | null;
  baseline: PreparedRemote | null;
  expected: { document: PreparedDocument } | PreparedRemote;
  receipt: unknown;
  readback: unknown;
  result: any;
  message: string;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
};
export type PreparedExecutionBatch = {
  id: string;
  batchId: string;
  fingerprint: string;
  inputSourceDigest: string;
  mode: 'simulation';
  state: string;
  hasActiveWork: boolean;
  counts: Record<PreparedExecutionJobState, number>;
  jobs: PreparedExecutionJob[];
  createdAt: string;
  submittedAt: string | null;
};
export function preparedExecutionFingerprint(
  input: Omit<PreparedExecutionInput, 'fingerprint'> | PreparedExecutionInput,
): string {
  const { fingerprint: _, ...body } = input as PreparedExecutionInput;
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const owner = (scope: Scope) => `${scope.environment}:${scope.partnerId}:${scope.shopId}`;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function normalized(remote: PreparedRemote): PreparedRemote {
  const copy = structuredClone(remote);
  copy.document.models.sort((a, b) => a.sku.localeCompare(b.sku));
  copy.modelBindings.sort((a, b) => a.sku.localeCompare(b.sku));
  return copy;
}
function diff(a: any, b: any, path = '', output: string[] = []): string[] {
  if (same(a ?? null, b ?? null) && (a === undefined) === (b === undefined)) return output;
  if (
    Array.isArray(a) !== Array.isArray(b) ||
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object'
  ) {
    if (output.length < 200) output.push(path);
    return output;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
    diff(a[key], b[key], path ? `${path}.${key}` : key, output);
  return output;
}
function bindingValid(remote: PreparedRemote) {
  const models = remote.document.models,
    bindings = remote.modelBindings;
  return (
    bindings.length === models.length &&
    new Set(bindings.map((b) => b.sku)).size === bindings.length &&
    new Set(bindings.map((b) => b.modelId)).size === bindings.length &&
    models.every((model) =>
      bindings.some(
        (binding) => binding.sku === model.sku && same(binding.tierIndex, model.tierIndex),
      ),
    )
  );
}
function documentEqual(a: PreparedDocument, b: PreparedDocument) {
  const sort = (document: PreparedDocument) => ({
    ...document,
    models: [...document.models].sort((one, two) => one.sku.localeCompare(two.sku)),
  });
  return diff(sort(a), sort(b), 'document');
}
function metadataIssues(document: PreparedDocument, metadata: PreparedMetadata): string[] {
  const issues: string[] = [];
  if (!metadata.supported || metadata.categoryId !== document.categoryId)
    issues.push('PREPARED_CATEGORY_UNAVAILABLE');
  if (metadata.minPrice > metadata.maxPrice) issues.push('PREPARED_METADATA_INVALID');
  if (metadata.requiredAttributes.some((key) => !document.attributes[key]?.length))
    issues.push('PREPARED_REQUIRED_ATTRIBUTES');
  if (
    Object.entries(document.attributes).some(
      ([key, values]) =>
        !metadata.allowedAttributeValues[key] ||
        values.some((value) => !metadata.allowedAttributeValues[key]!.includes(value)),
    )
  )
    issues.push('PREPARED_ATTRIBUTE_VALUE');
  if (!metadata.brandIds.includes(document.brandId)) issues.push('PREPARED_BRAND_UNAVAILABLE');
  if (
    !document.logistics.some((channel) => channel.enabled) ||
    document.logistics.some((channel) => !metadata.channelIds.includes(channel.channelId))
  )
    issues.push('PREPARED_CHANNEL_UNAVAILABLE');
  if (document.gallery.length > metadata.maxGallery || document.models.length > metadata.maxModels)
    issues.push('PREPARED_SOURCE_LIMIT');
  if (
    document.models.some(
      (model) =>
        Number(model.originalPrice) < metadata.minPrice ||
        Number(model.originalPrice) > metadata.maxPrice,
    )
  )
    issues.push('PREPARED_PRICE_LIMIT');
  if (document.models.some((model) => model.stock > metadata.maxStock))
    issues.push('PREPARED_STOCK_LIMIT');
  return issues;
}
function expectedUpdate(
  baseline: PreparedRemote,
  entry: PreparedEntry,
  fieldMask: PreparedField[],
  selectedSkus: string[],
): PreparedRemote {
  if (
    baseline.document.sourceKey !== entry.document.sourceKey ||
    !same(baseline.document.tierNames, entry.document.tierNames)
  )
    throw new Error('PREPARED_SOURCE_BINDING_CHANGED');
  const membership = (document: PreparedDocument) =>
    document.models
      .map((model) => ({
        sku: model.sku,
        tierIndex: model.tierIndex,
        optionLabels: model.optionLabels,
      }))
      .sort((a, b) => a.sku.localeCompare(b.sku));
  if (!same(membership(baseline.document), membership(entry.document)))
    throw new Error('PREPARED_MODEL_BINDING_CHANGED');
  const expected = structuredClone(baseline);
  for (const field of fieldMask) {
    if (skuFields.has(field)) {
      for (const sku of selectedSkus) {
        const actual = expected.document.models.find((model) => model.sku === sku)!,
          desired = entry.document.models.find((model) => model.sku === sku)!;
        if (field === 'price') actual.originalPrice = desired.originalPrice;
        if (field === 'stock') actual.stock = desired.stock;
        if (field === 'variationImages') {
          if (desired.image) actual.image = structuredClone(desired.image);
          else delete actual.image;
        }
      }
    } else if (field === 'logistics') {
      expected.document.logistics = structuredClone(entry.document.logistics);
      expected.document.weightGrams = entry.document.weightGrams;
      expected.document.dimensionCm = structuredClone(entry.document.dimensionCm);
    } else (expected.document as any)[field] = structuredClone((entry.document as any)[field]);
  }
  return expected;
}
function publicJob(row: any, now: Date): PreparedExecutionJob {
  const inFlight =
    ['running', 'unknown'].includes(row.state) &&
    !!row.claim_id &&
    !!row.lease_until &&
    new Date(row.lease_until).getTime() > now.getTime();
  const state: PreparedExecutionJobState =
    row.state === 'unknown' && inFlight ? 'running' : row.state;
  return {
    id: row.id,
    state,
    durableState: row.state,
    inFlight,
    blockedByUnresolvedOwner: row.owner_unresolved === true,
    paused: row.paused,
    mutationSent: row.mutation_sent,
    entry: row.entry,
    operation: row.operation,
    fieldMask: row.field_mask,
    selectedSkus: row.selected_skus,
    itemId: row.item_id,
    baseline: row.baseline,
    expected: row.expected,
    receipt: row.receipt,
    readback: row.readback,
    result: row.result,
    message:
      state === 'running'
        ? row.mutation_sent
          ? 'Đang gửi và đọc lại dữ liệu mô phỏng.'
          : 'Đang kiểm tra trước khi gửi mô phỏng.'
        : row.state === 'queued' && row.owner_unresolved
          ? 'Shop đang có công việc chưa rõ kết quả; cần đối chiếu trước khi tiếp tục.'
          : row.state === 'verified'
            ? 'Đã đối chiếu đủ dữ liệu trong mô phỏng.'
            : row.state === 'unknown'
              ? 'Kết quả chưa rõ; chỉ đọc lại để đối chiếu, không gửi lại.'
              : row.state === 'blocked'
                ? 'Nguồn, kết nối hoặc điều kiện của shop chưa đạt.'
                : row.state === 'cancelled'
                  ? 'Đã hủy trước khi gửi.'
                  : row.paused
                    ? 'Đã tạm dừng trước khi gửi.'
                    : row.state === 'running'
                      ? 'Đang kiểm tra trước khi gửi mô phỏng.'
                      : row.state === 'queued'
                        ? 'Đã xếp hàng mô phỏng.'
                        : 'Đã chuẩn bị, chưa gửi.',
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}
type Queryable = Pick<Pool, 'query'>;
export type PreparedEnqueueGuard = (client: Queryable) => Promise<void>;
// Bound waiting does not cancel a gateway mutation. Keep the owning lane unresolved while
// the local adapter promise is pending, even across coordinator instances sharing it.
const pendingGatewayMutations = new WeakMap<PreparedGateway, Set<string>>();

/** Business coordinator shared by API and workers. No default transport and no production adapter. */
export class PreparedExecutionService {
  constructor(
    readonly repo: Repository,
    readonly gateway: PreparedGateway,
    readonly options: { now?: () => Date; leaseMs?: number; requestTimeoutMs?: number } = {},
  ) {
    if (
      !gateway ||
      gateway.mode !== 'simulation' ||
      ['metadata', 'find', 'read', 'create', 'update'].some(
        (key) => typeof (gateway as any)[key] !== 'function',
      )
    )
      throw new Error('PREPARED_SIMULATION_REQUIRED');
    if (
      options.requestTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.requestTimeoutMs) ||
        options.requestTimeoutMs < 1 ||
        options.requestTimeoutMs > 2147483647)
    )
      throw new Error('PREPARED_TIMEOUT_INVALID');
    if (!pendingGatewayMutations.has(gateway)) pendingGatewayMutations.set(gateway, new Set());
  }
  private now() {
    return this.options.now?.() ?? new Date();
  }
  private until() {
    return new Date(this.now().getTime() + (this.options.leaseMs ?? 120000));
  }
  private async call<T>(
    fn: () => Promise<PreparedOutcome<T>>,
    mutationJobId?: string,
  ): Promise<PreparedOutcome<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = pendingGatewayMutations.get(this.gateway)!;
      if (mutationJobId) pending.add(mutationJobId);
      const operation = Promise.resolve()
        .then(fn)
        .finally(() => {
          if (mutationJobId) pending.delete(mutationJobId);
        });
      // A future wire adapter needs its own abort support. This only bounds coordinator waiting;
      // a late fulfillment is intentionally not adopted or replayed by this continuation.
      const value = await Promise.race([
        operation,
        new Promise<PreparedOutcome<T>>((resolve) => {
          timer = setTimeout(
            () => resolve({ kind: 'unknown', code: 'PREPARED_GATEWAY_TIMEOUT' }),
            this.options.requestTimeoutMs ?? 30000,
          );
        }),
      ]);
      if (
        value?.kind === 'success' &&
        typeof value.requestId === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(value.requestId)
      )
        return structuredClone(value);
      if (
        (value?.kind === 'rejected' || value?.kind === 'unknown') &&
        /^[A-Za-z0-9_.-]{1,100}$/.test(value.code)
      )
        return structuredClone(value);
      return { kind: 'unknown', code: 'PREPARED_INVALID_RESPONSE' };
    } catch {
      return { kind: 'unknown', code: 'PREPARED_GATEWAY_UNKNOWN' };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  private async connection(
    entry: PreparedEntry,
    query: Queryable = this.repo.pool,
    renewedRead = false,
  ): Promise<Scope> {
    const row = (
      await query.query(
        'SELECT environment,partner_id,shop_id,revision,capability_revision,state,expires_at FROM connections WHERE id=$1',
        [entry.connectionId],
      )
    ).rows[0];
    if (
      !row ||
      row.environment !== 'sandbox' ||
      entry.scope.environment !== 'sandbox' ||
      row.partner_id !== entry.scope.partnerId ||
      row.shop_id !== entry.scope.shopId
    )
      throw new Error('PREPARED_SCOPE_MISMATCH');
    if (
      row.state !== 'connected' ||
      (row.expires_at && new Date(row.expires_at).getTime() <= this.now().getTime())
    )
      throw new Error('PREPARED_CONNECTION_REQUIRED');
    if (
      !renewedRead &&
      (row.revision !== entry.scope.connectionRevision ||
        row.capability_revision !== entry.scope.capabilityRevision)
    )
      throw new Error('PREPARED_CONNECTION_CHANGED');
    return {
      ...entry.scope,
      connectionRevision: row.revision,
      capabilityRevision: row.capability_revision,
    };
  }
  private async metadata(scope: Scope, document: PreparedDocument): Promise<string[]> {
    const result = await this.call(() =>
      this.gateway.metadata(structuredClone(scope), document.categoryId),
    );
    if (result.kind !== 'success') return ['PREPARED_METADATA_UNAVAILABLE', result.code];
    const parsed = metadataSchema.safeParse(result.data);
    return parsed.success ? metadataIssues(document, parsed.data) : ['PREPARED_METADATA_INVALID'];
  }
  private async read(scope: Scope, itemId: string): Promise<PreparedOutcome<PreparedRemote>> {
    const result = await this.call(() => this.gateway.read(structuredClone(scope), itemId));
    if (result.kind !== 'success') return result;
    const parsed = remoteSchema.safeParse(result.data);
    return parsed.success && parsed.data.itemId === itemId && bindingValid(parsed.data)
      ? { ...result, data: parsed.data }
      : { kind: 'unknown', code: 'PREPARED_REMOTE_BINDING_INVALID' };
  }
  private code(error: unknown) {
    return error instanceof Error && /^PREPARED_[A-Z_]+$/.test(error.message)
      ? error.message
      : 'PREPARED_VALIDATION_FAILED';
  }
  async prepare(raw: PreparedExecutionInput): Promise<PreparedExecutionBatch> {
    const input = inputSchema.parse(raw) as PreparedExecutionInput;
    if (preparedExecutionFingerprint(input) !== input.fingerprint)
      throw new Error('PREPARED_FINGERPRINT_MISMATCH');
    if (input.operation === 'update' && !input.fieldMask.length)
      throw new Error('PREPARED_FIELD_SELECTION_REQUIRED');
    if (
      new Set(input.fieldMask).size !== input.fieldMask.length ||
      (input.selectedSkus && new Set(input.selectedSkus).size !== input.selectedSkus.length)
    )
      throw new Error('PREPARED_DUPLICATE_SELECTION');
    const identities = input.entries.map(
      (entry) => owner(entry.scope) + ':' + entry.document.sourceKey,
    );
    if (new Set(identities).size !== identities.length)
      throw new Error('PREPARED_DUPLICATE_SOURCE_TARGET');
    const knownSkus = new Set(
      input.entries.flatMap((entry) => entry.document.models.map((model) => model.sku)),
    );
    if (input.selectedSkus?.some((sku) => !knownSkus.has(sku)))
      throw new Error('PREPARED_UNKNOWN_SKU');
    const existing = (
      await this.repo.pool.query(
        'SELECT id,fingerprint FROM prepared_execution_batches WHERE fingerprint=$1 OR id=$2',
        [input.fingerprint, input.batchId],
      )
    ).rows[0];
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) throw new Error('PREPARED_INTENT_CONFLICT');
      return this.get(existing.id);
    }
    const planned: {
      entry: PreparedEntry;
      selectedSkus: string[];
      baseline: PreparedRemote | null;
      expected: PreparedExecutionJob['expected'];
      issues: string[];
      intentKey: string;
    }[] = [];
    for (const entry of input.entries) {
      const selectedSkus = entry.document.models
        .map((model) => model.sku)
        .filter((sku) => input.selectedSkus === undefined || input.selectedSkus.includes(sku));
      let baseline: PreparedRemote | null = null,
        expected: PreparedExecutionJob['expected'] = { document: entry.document };
      const issues: string[] = [];
      try {
        const scope = await this.connection(entry);
        if (input.operation === 'create') {
          const found = await this.call(() =>
            this.gateway.find(structuredClone(scope), entry.document.sourceKey),
          );
          if (found.kind !== 'success' || !Array.isArray(found.data))
            issues.push('PREPARED_SOURCE_LOOKUP_UNAVAILABLE');
          else if (found.data.length) issues.push('PREPARED_REMOTE_SOURCE_EXISTS');
        } else {
          const binding = (
            await this.repo.pool.query(
              'SELECT * FROM prepared_execution_bindings WHERE owner_key=$1 AND source_key=$2',
              [owner(scope), entry.document.sourceKey],
            )
          ).rows[0];
          if (!binding || binding.state !== 'bound' || !binding.item_id)
            throw new Error('PREPARED_BINDING_REQUIRED');
          const read = await this.read(scope, binding.item_id);
          if (read.kind !== 'success') throw new Error('PREPARED_BASELINE_UNAVAILABLE');
          baseline = read.data;
          if (
            !same(
              normalized(baseline).modelBindings,
              [...binding.model_bindings].sort((a: any, b: any) => a.sku.localeCompare(b.sku)),
            )
          )
            throw new Error('PREPARED_MODEL_BINDING_CHANGED');
          expected = expectedUpdate(baseline, entry, input.fieldMask, selectedSkus);
          if (!selectedSkus.length && input.fieldMask.every((field) => skuFields.has(field)))
            issues.push('PREPARED_NO_SELECTED_SKUS');
        }
        issues.push(...(await this.metadata(scope, expected.document)));
      } catch (error) {
        issues.push(this.code(error));
      }
      const intentKey = hash({
        owner: owner(entry.scope),
        sourceKey: entry.document.sourceKey,
        sourceFingerprint: entry.sourceFingerprint,
        operation: input.operation,
        fields: [...input.fieldMask].sort(),
        selectedSkus: [...selectedSkus].sort(),
      });
      planned.push({ entry, selectedSkus, baseline, expected, issues, intentKey });
    }
    const batchId = await transaction(this.repo.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'prepared-batch:' + input.batchId,
      ]);
      const replay = (
        await client.query(
          'SELECT id,fingerprint FROM prepared_execution_batches WHERE fingerprint=$1 OR id=$2',
          [input.fingerprint, input.batchId],
        )
      ).rows[0];
      if (replay) {
        if (replay.fingerprint !== input.fingerprint) throw new Error('PREPARED_INTENT_CONFLICT');
        return replay.id as string;
      }
      for (const key of [...new Set(input.entries.map((entry) => owner(entry.scope)))].sort())
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'prepared-owner:' + key,
        ]);
      const id = input.batchId;
      await client.query(
        "INSERT INTO prepared_execution_batches(id,batch_id,fingerprint,input_source_digest,input,mode) VALUES($1,$2,$3,$4,$5,'simulation')",
        [id, input.batchId, input.fingerprint, input.inputSourceDigest, input],
      );
      for (const [position, plan] of planned.entries()) {
        const key = owner(plan.entry.scope),
          jobId = randomUUID(),
          issues = [...plan.issues];
        try {
          await this.connection(plan.entry, client);
        } catch (error) {
          issues.push(this.code(error));
        }
        const binding = (
          await client.query(
            'SELECT * FROM prepared_execution_bindings WHERE owner_key=$1 AND source_key=$2 FOR UPDATE',
            [key, plan.entry.document.sourceKey],
          )
        ).rows[0];
        if (input.operation === 'create' && binding)
          issues.push('PREPARED_CREATE_ALREADY_RESERVED');
        if (
          input.operation === 'update' &&
          (!binding || binding.state !== 'bound' || binding.item_id !== plan.baseline?.itemId)
        )
          issues.push('PREPARED_BINDING_CHANGED');
        if (
          (
            await client.query(
              "SELECT id FROM prepared_execution_jobs WHERE intent_key=$1 AND state NOT IN ('blocked','cancelled') LIMIT 1",
              [plan.intentKey],
            )
          ).rowCount
        )
          issues.push('PREPARED_INTENT_ALREADY_EXISTS');
        const state = issues.length ? 'blocked' : 'prepared';
        await client.query(
          'INSERT INTO prepared_execution_jobs(id,batch_id,position,connection_id,owner_key,source_key,intent_key,entry,operation,field_mask,selected_skus,state,item_id,baseline,expected,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
          [
            jobId,
            id,
            position,
            plan.entry.connectionId,
            key,
            plan.entry.document.sourceKey,
            plan.intentKey,
            plan.entry,
            input.operation,
            JSON.stringify(input.fieldMask),
            JSON.stringify(plan.selectedSkus),
            state,
            plan.baseline?.itemId ?? null,
            plan.baseline,
            plan.expected,
            {
              code: issues.length ? 'PREPARED_BLOCKED' : 'PREPARED_READY',
              issues: [...new Set(issues)],
            },
          ],
        );
        if (state === 'prepared' && input.operation === 'create')
          await client.query(
            "INSERT INTO prepared_execution_bindings(owner_key,source_key,create_job_id,state) VALUES($1,$2,$3,'reserved')",
            [key, plan.entry.document.sourceKey, jobId],
          );
      }
      return id;
    });
    return this.get(batchId);
  }
  async get(id: string): Promise<PreparedExecutionBatch> {
    const row = (
      await this.repo.pool.query('SELECT * FROM prepared_execution_batches WHERE id=$1', [
        z.string().uuid().parse(id),
      ])
    ).rows[0];
    if (!row) throw new Error('PREPARED_NOT_FOUND');
    const now = this.now();
    const jobs = (
      await this.repo.pool.query(
        `SELECT j.*, EXISTS (
          SELECT 1 FROM prepared_execution_jobs blocker WHERE blocker.owner_key=j.owner_key
          AND blocker.state='unknown' AND (blocker.claim_id IS NULL OR blocker.lease_until IS NULL OR blocker.lease_until<=$2)
        ) AS owner_unresolved FROM prepared_execution_jobs j WHERE j.batch_id=$1 ORDER BY j.position`,
        [id, now],
      )
    ).rows.map((job) => publicJob(job, now));
    const counts = {
      prepared: 0,
      queued: 0,
      running: 0,
      unknown: 0,
      verified: 0,
      blocked: 0,
      cancelled: 0,
    };
    jobs.forEach((job) => counts[job.state]++);
    // An unresolved owner holds only its own lane. Other owners, including those awaiting
    // a currently active claim in another batch, still need progress polling.
    const queuedCanProgress = jobs.some(
      (job) => job.state === 'queued' && !job.paused && !job.blockedByUnresolvedOwner,
    );
    const hasActiveWork = counts.running > 0 || queuedCanProgress;
    const state = counts.running
      ? 'running'
      : queuedCanProgress
        ? 'queued'
        : counts.unknown ||
            jobs.some(
              (job) => job.state === 'queued' && !job.paused && job.blockedByUnresolvedOwner,
            )
          ? 'unknown'
          : counts.queued
            ? jobs.filter((job) => job.state === 'queued').every((job) => job.paused)
              ? 'paused'
              : 'queued'
            : counts.prepared
              ? 'prepared'
              : counts.verified === jobs.length
                ? 'verified'
                : counts.cancelled === jobs.length
                  ? 'cancelled'
                  : 'blocked';
    return {
      id: row.id,
      batchId: row.batch_id,
      fingerprint: row.fingerprint,
      inputSourceDigest: row.input_source_digest,
      mode: 'simulation',
      state,
      hasActiveWork,
      counts,
      jobs,
      createdAt: row.created_at.toISOString(),
      submittedAt: row.submitted_at?.toISOString() ?? null,
    };
  }
  async list(): Promise<PreparedExecutionBatch[]> {
    const rows = (
      await this.repo.pool.query(
        'SELECT id FROM prepared_execution_batches ORDER BY created_at DESC,id LIMIT 200',
      )
    ).rows;
    return Promise.all(rows.map((row) => this.get(row.id)));
  }
  async submit(
    id: string,
    fingerprint: string,
    beforeEnqueue?: PreparedEnqueueGuard,
  ): Promise<PreparedExecutionBatch> {
    await transaction(this.repo.pool, async (client) => {
      const batch = (
        await client.query('SELECT * FROM prepared_execution_batches WHERE id=$1 FOR UPDATE', [
          z.string().uuid().parse(id),
        ])
      ).rows[0];
      if (!batch || batch.fingerprint !== fingerprint)
        throw new Error('PREPARED_FINGERPRINT_MISMATCH');
      // The caller can pin its source revision with this same client through the queue transition.
      // Repeated submissions do not re-run a changed-source guard for an already recorded command.
      if (
        beforeEnqueue &&
        (
          await client.query(
            "SELECT 1 FROM prepared_execution_jobs WHERE batch_id=$1 AND state='prepared' LIMIT 1",
            [id],
          )
        ).rowCount
      )
        await beforeEnqueue(client);
      await client.query(
        "UPDATE prepared_execution_jobs SET state='queued',updated_at=$2 WHERE batch_id=$1 AND state='prepared'",
        [id, this.now()],
      );
      await client.query(
        'UPDATE prepared_execution_batches SET submitted_at=COALESCE(submitted_at,$2) WHERE id=$1',
        [id, this.now()],
      );
    });
    return this.get(id);
  }
  private async job(id: string) {
    const row = (
      await this.repo.pool.query('SELECT * FROM prepared_execution_jobs WHERE id=$1', [
        z.string().uuid().parse(id),
      ])
    ).rows[0];
    if (!row) throw new Error('PREPARED_JOB_NOT_FOUND');
    return row;
  }
  private async blocked(row: any, code: string, evidence?: unknown) {
    await transaction(this.repo.pool, async (client) => {
      const updated = await client.query(
        "UPDATE prepared_execution_jobs SET state='blocked',result=$3,claim_id=NULL,lease_until=NULL,updated_at=$4 WHERE id=$1 AND claim_id=$2 AND state='running' AND NOT mutation_sent",
        [row.id, row.claim_id, { code, mutationSent: false, evidence }, this.now()],
      );
      if (updated.rowCount)
        await client.query(
          "DELETE FROM prepared_execution_bindings WHERE create_job_id=$1 AND state='reserved'",
          [row.id],
        );
    });
  }
  async runOnce(): Promise<boolean> {
    const row = await transaction(this.repo.pool, async (client) => {
      // Only prewrite claims may be reclaimed. A recorded mutation remains unknown forever until read reconciliation.
      await client.query(
        "UPDATE prepared_execution_jobs SET state='queued',claim_id=NULL,lease_until=NULL,updated_at=$1 WHERE state='running' AND NOT mutation_sent AND lease_until<=$1",
        [this.now()],
      );
      const candidate = (
        await client.query(
          "SELECT j.* FROM prepared_execution_jobs j WHERE j.state='queued' AND NOT j.paused AND NOT EXISTS (SELECT 1 FROM prepared_execution_jobs active WHERE active.owner_key=j.owner_key AND active.state IN ('running','unknown')) ORDER BY j.created_at,j.position FOR UPDATE OF j SKIP LOCKED LIMIT 1",
        )
      ).rows[0];
      if (!candidate) return null;
      const locked = (
        await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok', [
          'prepared-owner:' + candidate.owner_key,
        ])
      ).rows[0];
      if (
        !locked.ok ||
        (
          await client.query(
            "SELECT id FROM prepared_execution_jobs WHERE owner_key=$1 AND state IN ('running','unknown') LIMIT 1",
            [candidate.owner_key],
          )
        ).rowCount
      )
        return null;
      return (
        await client.query(
          "UPDATE prepared_execution_jobs SET state='running',claim_id=$2,lease_until=$3,updated_at=$4 WHERE id=$1 RETURNING *",
          [candidate.id, randomUUID(), this.until(), this.now()],
        )
      ).rows[0];
    });
    if (!row) return false;
    const entry: PreparedEntry = row.entry;
    try {
      await this.connection(entry);
      const issues = await this.metadata(entry.scope, row.expected.document);
      if (issues.length) {
        await this.blocked(row, 'PREPARED_METADATA_CHANGED', issues);
        return true;
      }
      if (row.operation === 'create') {
        const found = await this.call(() =>
          this.gateway.find(structuredClone(entry.scope), row.source_key),
        );
        if (found.kind !== 'success' || !Array.isArray(found.data) || found.data.length) {
          await this.blocked(row, 'PREPARED_CREATE_TARGET_CHANGED', found);
          return true;
        }
      } else {
        const current = await this.read(entry.scope, row.item_id);
        if (
          current.kind !== 'success' ||
          !same(normalized(current.data), normalized(row.baseline))
        ) {
          await this.blocked(row, 'PREPARED_BASELINE_CHANGED', current);
          return true;
        }
      }
      const sent = await transaction(this.repo.pool, async (client) => {
        const claim = (
          await client.query(
            "SELECT * FROM prepared_execution_jobs WHERE id=$1 AND claim_id=$2 AND state='running' AND NOT paused AND lease_until>$3 FOR UPDATE",
            [row.id, row.claim_id, this.now()],
          )
        ).rows[0];
        if (!claim) return false;
        await client.query('SELECT id FROM connections WHERE id=$1 FOR SHARE', [
          entry.connectionId,
        ]);
        await this.connection(entry, client);
        await client.query(
          "UPDATE prepared_execution_jobs SET state='unknown',mutation_sent=true,started_at=$2,lease_until=$3,result=$4,updated_at=$2 WHERE id=$1",
          [row.id, this.now(), this.until(), { code: 'PREPARED_WRITE_INTENT_RECORDED' }],
        );
        if (row.operation === 'create')
          await client.query(
            "UPDATE prepared_execution_bindings SET state='unknown',updated_at=$2 WHERE create_job_id=$1",
            [row.id, this.now()],
          );
        return true;
      });
      if (!sent) return true;
    } catch (error) {
      await this.blocked(row, this.code(error));
      return true;
    }
    const receipt =
      row.operation === 'create'
        ? await this.call(
            () =>
              this.gateway.create(
                structuredClone(entry.scope),
                structuredClone(row.expected.document),
              ),
            row.id,
          )
        : await this.call(
            () =>
              this.gateway.update(
                structuredClone(entry.scope),
                row.item_id,
                structuredClone(row.expected),
                structuredClone(row.field_mask),
                structuredClone(row.selected_skus),
              ),
            row.id,
          );
    let itemId = row.item_id;
    if (row.operation === 'create' && receipt.kind === 'success') {
      const id = z.object({ itemId: identifier }).strict().safeParse(receipt.data);
      if (id.success) itemId = id.data.itemId;
    }
    const owned = await this.repo.pool.query(
      "UPDATE prepared_execution_jobs SET receipt=$3,item_id=COALESCE(item_id,$4),updated_at=$5 WHERE id=$1 AND claim_id=$2 AND state='unknown'",
      [row.id, row.claim_id, receipt, itemId, this.now()],
    );
    if (!owned.rowCount) return true;
    if (itemId && !(receipt.kind === 'unknown' && receipt.code === 'PREPARED_GATEWAY_TIMEOUT'))
      await this.finishRead({ ...row, item_id: itemId }, entry.scope);
    else
      await this.repo.pool.query(
        "UPDATE prepared_execution_jobs SET claim_id=NULL,lease_until=NULL,result=$3,updated_at=$4 WHERE id=$1 AND claim_id=$2 AND state='unknown'",
        [row.id, row.claim_id, { code: 'PREPARED_WRITE_UNRESOLVED' }, this.now()],
      );
    return true;
  }
  private async finishRead(row: any, scope: Scope) {
    const readback = await this.read(scope, row.item_id);
    let mismatchedPaths: string[] = [],
      verified = false;
    if (readback.kind === 'success') {
      mismatchedPaths =
        row.operation === 'create'
          ? documentEqual(row.expected.document, readback.data.document)
          : diff(normalized(row.expected), normalized(readback.data));
      verified = mismatchedPaths.length === 0;
    }
    await transaction(this.repo.pool, async (client) => {
      const current = (
        await client.query(
          "SELECT * FROM prepared_execution_jobs WHERE id=$1 AND claim_id=$2 AND state='unknown' FOR UPDATE",
          [row.id, row.claim_id],
        )
      ).rows[0];
      if (!current) return;
      if (verified && readback.kind === 'success') {
        const collision = (
          await client.query(
            'SELECT source_key FROM prepared_execution_bindings WHERE owner_key=$1 AND item_id=$2 AND source_key<>$3',
            [row.owner_key, row.item_id, row.source_key],
          )
        ).rows[0];
        if (collision) {
          verified = false;
          mismatchedPaths.push('itemId.ownerBinding');
        } else
          await client.query(
            "UPDATE prepared_execution_bindings SET state='bound',item_id=$3,model_bindings=$4,snapshot=$5,updated_at=$6 WHERE owner_key=$1 AND source_key=$2",
            [
              row.owner_key,
              row.source_key,
              row.item_id,
              JSON.stringify(readback.data.modelBindings),
              readback.data,
              this.now(),
            ],
          );
      }
      await client.query(
        'UPDATE prepared_execution_jobs SET state=$3,readback=$4,result=$5,claim_id=NULL,lease_until=NULL,updated_at=$6 WHERE id=$1 AND claim_id=$2',
        [
          row.id,
          row.claim_id,
          verified ? 'verified' : 'unknown',
          readback,
          {
            code: verified ? 'PREPARED_READBACK_VERIFIED' : 'PREPARED_READBACK_UNRESOLVED',
            verified,
            mismatchedPaths,
            readScope: scope,
          },
          this.now(),
        ],
      );
    });
  }
  async reconcile(id: string): Promise<PreparedExecutionJob> {
    if (pendingGatewayMutations.get(this.gateway)!.has(id))
      throw new Error('PREPARED_STILL_RUNNING');
    const row = await transaction(this.repo.pool, async (client) => {
      const current = (
        await client.query('SELECT * FROM prepared_execution_jobs WHERE id=$1 FOR UPDATE', [
          z.string().uuid().parse(id),
        ])
      ).rows[0];
      if (!current) throw new Error('PREPARED_JOB_NOT_FOUND');
      if (current.state !== 'unknown') return null;
      if (current.lease_until && new Date(current.lease_until).getTime() > this.now().getTime())
        throw new Error('PREPARED_STILL_RUNNING');
      return (
        await client.query(
          'UPDATE prepared_execution_jobs SET claim_id=$2,lease_until=$3 WHERE id=$1 RETURNING *',
          [id, randomUUID(), this.until()],
        )
      ).rows[0];
    });
    if (!row) return publicJob(await this.job(id), this.now());
    try {
      const scope = await this.connection(row.entry, this.repo.pool, true);
      if (!row.item_id) {
        const found = await this.call(() =>
          this.gateway.find(structuredClone(scope), row.source_key),
        );
        if (found.kind !== 'success' || !Array.isArray(found.data) || found.data.length !== 1)
          throw new Error('PREPARED_RECONCILIATION_AMBIGUOUS');
        const remote = remoteSchema.safeParse(found.data[0]);
        if (
          !remote.success ||
          !bindingValid(remote.data) ||
          documentEqual(row.expected.document, remote.data.document).length
        )
          throw new Error('PREPARED_RECONCILIATION_MISMATCH');
        row.item_id = remote.data.itemId;
        await this.repo.pool.query(
          "UPDATE prepared_execution_jobs SET item_id=$3 WHERE id=$1 AND claim_id=$2 AND state='unknown'",
          [row.id, row.claim_id, row.item_id],
        );
      }
      await this.finishRead(row, scope);
    } catch (error) {
      await this.repo.pool.query(
        "UPDATE prepared_execution_jobs SET claim_id=NULL,lease_until=NULL,result=$3,updated_at=$4 WHERE id=$1 AND claim_id=$2 AND state='unknown'",
        [row.id, row.claim_id, { code: this.code(error), verified: false }, this.now()],
      );
    }
    return publicJob(await this.job(id), this.now());
  }
  async control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<PreparedExecutionJob> {
    z.enum(['pause', 'resume', 'cancel']).parse(action);
    await transaction(this.repo.pool, async (client) => {
      const row = (
        await client.query('SELECT * FROM prepared_execution_jobs WHERE id=$1 FOR UPDATE', [
          z.string().uuid().parse(id),
        ])
      ).rows[0];
      if (!row) throw new Error('PREPARED_JOB_NOT_FOUND');
      if (row.state === 'unknown' || (row.mutation_sent && row.state !== 'verified'))
        throw new Error('PREPARED_RECONCILIATION_REQUIRED');
      if (row.state === 'running') throw new Error('PREPARED_STILL_RUNNING');
      if (['verified', 'cancelled', 'blocked'].includes(row.state)) return;
      await client.query(
        'UPDATE prepared_execution_jobs SET paused=$2,state=$3,updated_at=$4 WHERE id=$1',
        [id, action === 'pause', action === 'cancel' ? 'cancelled' : row.state, this.now()],
      );
      if (action === 'cancel')
        await client.query(
          "DELETE FROM prepared_execution_bindings WHERE create_job_id=$1 AND state='reserved'",
          [id],
        );
    });
    return publicJob(await this.job(id), this.now());
  }
}
