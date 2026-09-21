import { z } from 'zod';
import type {
  ListingDraft,
  AssetRef,
  SandboxSnapshot,
  SandboxScopeInput,
  SandboxPrepareInput,
  SandboxRun,
  SandboxReadResult,
  SandboxCheck,
  SandboxField,
  RemoteDescriptionBlock,
  WorkOrderConfig,
} from '@shopee/domain';
import type { Pool, PoolClient } from 'pg';
import {
  Repository,
  BlobStore,
  transaction,
  lockSandboxMutationLane,
  sandboxMutationLaneBusy,
} from '@shopee/persistence';
import {
  SandboxProductClient,
  SecretBox,
  productFingerprint,
  snapshotContent,
  stableJson,
  type ShopCredentials,
  type SelectiveItemPatch,
  type ProductOutcome,
} from '@shopee/gateway';

const scopeSchema = z
  .object({
    connectionId: z.string().uuid(),
    itemId: z.string().regex(/^\d+$/),
    productKey: z.string().min(1).max(200),
    sourceRevision: z.number().int().positive(),
  })
  .strict();
const prepareSchema = scopeSchema
  .extend({
    id: z.string().uuid(),
    workOrderId: z.string().uuid(),
    workOrderRevision: z.number().int().positive(),
    baselineFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    fieldMask: z
      .array(z.enum(['title', 'description', 'gallery']))
      .min(1)
      .max(3)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
const changeSchema = z
  .object({ id: z.string().uuid(), expectedRevision: z.number().int().positive() })
  .strict();
type Intent = {
  input: SandboxPrepareInput;
  draft: ListingDraft;
  connectionRevision: number;
  limits: Record<string, unknown>;
};
type StoredBody = Pick<SandboxRun, 'fieldMask' | 'baseline' | 'preview' | 'uploads' | 'result'> & {
  phase: 'prepared' | 'claimed' | 'uploading' | 'write_intent' | 'readback' | 'done';
  patch?: SelectiveItemPatch;
  expected?: SandboxSnapshot;
};
type Stored = {
  id: string;
  revision: number;
  state: SandboxRun['state'];
  connection_id: string;
  item_id: string;
  product_key: string;
  source_revision: number;
  input_fingerprint: string;
  intent: Intent;
  body: StoredBody;
  created_at: Date;
  updated_at: Date;
};
function publicRun(row: Stored): SandboxRun {
  return {
    id: row.id,
    workOrderId: row.intent.input.workOrderId,
    workOrderRevision: row.intent.input.workOrderRevision,
    revision: row.revision,
    state: row.state,
    connectionId: row.connection_id,
    itemId: row.item_id,
    productKey: row.product_key,
    sourceRevision: row.source_revision,
    fieldMask: row.body.fieldMask,
    baseline: row.body.baseline,
    preview: row.body.preview,
    uploads: row.body.uploads,
    result: row.body.result,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
function fail(code: string): never {
  throw new Error(code);
}
function outcome<T>(result: ProductOutcome<T>): T {
  if (result.kind === 'success') return result.data;
  if (result.kind === 'rejected') throw new Error('SANDBOX_API_REJECTED:' + result.code);
  if (result.httpStatus) throw new Error('SANDBOX_API_HTTP_' + result.httpStatus);
  throw new Error('SANDBOX_API_UNKNOWN');
}
function structureChecks(draft: ListingDraft, snapshot: SandboxSnapshot): SandboxCheck[] {
  const checks: SandboxCheck[] = [];
  const local = draft.variants.map((v) => v.sku.value),
    remote = snapshot.models.map((m) => m.sku);
  if (
    new Set(local).size !== local.length ||
    new Set(remote).size !== remote.length ||
    local.some((s) => !s) ||
    remote.some((s) => !s) ||
    stableJson([...local].sort()) !== stableJson([...remote].sort())
  )
    checks.push({
      code: 'SANDBOX_SKU_MISMATCH',
      field: 'variants',
      message: 'Danh sách SKU trên link khác bộ nguồn. Cần xác định đúng link trước khi cập nhật.',
    });
  if (
    stableJson(draft.tierNames) !== stableJson(snapshot.tierNames) ||
    draft.variants.some(
      (v) =>
        stableJson(v.optionLabels) !==
        stableJson(snapshot.models.find((m) => m.sku === v.sku.value)?.optionLabels),
    )
  )
    checks.push({
      code: 'SANDBOX_VARIATION_MISMATCH',
      field: 'variants',
      message:
        'Tên hoặc vị trí phân loại trên link khác bộ nguồn; ứng dụng không tự thay cấu trúc.',
    });
  if (draft.variants.some((v) => !v.sku.confirmed))
    checks.push({
      code: 'SANDBOX_SKU_UNCONFIRMED',
      field: 'variants',
      message: 'Cần xác nhận các SKU thuộc bộ nguồn.',
    });
  return checks;
}
function selectedAssetKeys(draft: ListingDraft, fields: SandboxField[]) {
  return [
    ...new Set([
      ...(fields.includes('gallery') ? draft.galleryKeys : []),
      ...(fields.includes('description')
        ? draft.description.filter((b) => b.type === 'image').map((b) => b.assetKey)
        : []),
    ]),
  ];
}
function sourceDescription(draft: ListingDraft): unknown {
  return draft.description;
}
function matches(a: unknown, b: unknown) {
  return stableJson(a) === stableJson(b);
}
function preservation(snapshot: SandboxSnapshot, fields: SandboxField[]) {
  const content = snapshotContent(snapshot);
  if (fields.includes('title')) delete (content as Partial<typeof content>).title;
  if (fields.includes('description')) {
    delete (content as Partial<typeof content>).description;
    delete (content as Partial<typeof content>).descriptionType;
  }
  if (fields.includes('gallery')) delete (content as Partial<typeof content>).gallery;
  return content;
}
function onlyCoverIdsDiffer(
  actual: SandboxSnapshot,
  baseline: SandboxSnapshot,
  fields: SandboxField[],
) {
  if (matches(actual.coverImageIds, baseline.coverImageIds)) return false;
  const exceptCoverIds = (snapshot: SandboxSnapshot) => {
    const content = structuredClone(preservation(snapshot, fields));
    delete (content as Partial<typeof content>).coverImageIds;
    const item = content.protectedFields.item;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const promotion = (item as Record<string, unknown>).promotion_image;
      if (promotion && typeof promotion === 'object' && !Array.isArray(promotion))
        delete (promotion as Record<string, unknown>).image_id_list;
    }
    return content;
  };
  // This narrows the diagnosis only. The strict preservation result remains false.
  return matches(exceptCoverIds(actual), exceptCoverIds(baseline));
}
function fieldsMatch(actual: SandboxSnapshot, expected: SandboxSnapshot, fields: SandboxField[]) {
  return fields.every((field) =>
    field === 'description'
      ? matches(actual.description, expected.description) &&
        actual.descriptionType === expected.descriptionType
      : matches(actual[field], expected[field]),
  );
}
function bound(value: number, limits: unknown) {
  const range = z
    .object({
      min_limit: z.number().finite().nonnegative(),
      max_limit: z.number().finite().nonnegative(),
    })
    .safeParse(limits);
  return (
    range.success &&
    range.data.max_limit >= range.data.min_limit &&
    value >= range.data.min_limit &&
    value <= range.data.max_limit
  );
}
function validateLimits(
  draft: ListingDraft,
  snapshot: SandboxSnapshot,
  fields: SandboxField[],
  limits: Record<string, unknown>,
) {
  if (fields.includes('title')) {
    if (!draft.title.confirmed || !draft.title.sources.length) fail('SANDBOX_TITLE_UNCONFIRMED');
    if (!bound(Array.from(draft.title.value).length, limits.item_name_length_limit))
      fail('SANDBOX_TITLE_LIMIT_UNVERIFIED');
  }
  if (fields.includes('gallery')) {
    if (!bound(draft.galleryKeys.length, limits.item_image_count_limit))
      fail('SANDBOX_GALLERY_LIMIT_UNVERIFIED');
    const assets = draft.galleryKeys.map(
      (k) => draft.assets.find((a) => a.key === k) ?? fail('SANDBOX_SOURCE_ASSET_MISSING'),
    );
    const ratios = new Set<string>(
      assets.map((a) =>
        a.width === a.height ? '1:1' : a.width * 4 === a.height * 3 ? '3:4' : 'unsupported',
      ),
    );
    if (ratios.size !== 1 || ratios.has('unsupported') || !ratios.has(snapshot.gallery.ratio ?? ''))
      fail('SANDBOX_GALLERY_RATIO_UNVERIFIED');
    if (
      snapshot.gallery.ratio === '3:4' &&
      (snapshot.coverImageIds.length !== 1 ||
        !/^[A-Za-z0-9_-]{1,512}$/.test(snapshot.coverImageIds[0] ?? ''))
    )
      fail('SANDBOX_COVER_PRESERVATION_REQUIRED');
  }
  if (fields.includes('description')) {
    const images = draft.description.filter((b) => b.type === 'image');
    const textLength = draft.description
      .filter((b) => b.type === 'text')
      .reduce((n, b) => n + Array.from(b.text).length, 0);
    if (!images.length && snapshot.descriptionType !== 'extended') {
      if (!bound(textLength, limits.item_description_length_limit))
        fail('SANDBOX_DESCRIPTION_LIMIT_UNVERIFIED');
    } else {
      if (snapshot.descriptionType !== 'extended') fail('SANDBOX_EXTENDED_DESCRIPTION_UNVERIFIED');
      const parsed = z
        .object({
          description_text_length_min: z.number(),
          description_text_length_max: z.number(),
          description_image_num_min: z.number(),
          description_image_num_max: z.number(),
          description_image_width_min: z.number(),
          description_image_height_min: z.number(),
          description_image_aspect_ratio_min: z.number(),
          description_image_aspect_ratio_max: z.number(),
        })
        .safeParse(limits.extended_description_limit);
      if (!parsed.success) fail('SANDBOX_DESCRIPTION_LIMIT_UNVERIFIED');
      const l = parsed.data;
      if (
        textLength < l.description_text_length_min ||
        textLength > l.description_text_length_max ||
        images.length < l.description_image_num_min ||
        images.length > l.description_image_num_max
      )
        fail('SANDBOX_DESCRIPTION_LIMIT_UNVERIFIED');
      for (const block of images) {
        const asset =
          draft.assets.find((a) => a.key === block.assetKey) ??
          fail('SANDBOX_SOURCE_ASSET_MISSING');
        if (
          asset.width < l.description_image_width_min ||
          asset.height < l.description_image_height_min ||
          asset.width / asset.height < l.description_image_aspect_ratio_min ||
          asset.width / asset.height > l.description_image_aspect_ratio_max
        )
          fail('SANDBOX_DESCRIPTION_MEDIA_LIMIT');
      }
    }
  }
}
export class SandboxListingService {
  constructor(
    private readonly repo: Repository,
    private readonly blobs: BlobStore,
    private readonly options: { transport?: typeof fetch; encryptionKey?: string } = {},
  ) {}
  private async assertWorkOrder(
    input: SandboxPrepareInput,
    query: Pool | PoolClient = this.repo.pool,
    lock = false,
  ) {
    if (!input.workOrderId || !input.workOrderRevision) fail('SANDBOX_WORK_ORDER_REQUIRED');
    if (lock)
      await query.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'work-order:' + input.workOrderId,
      ]);
    const current = (
      await query.query(
        `SELECT w.latest_revision,r.config FROM work_orders w JOIN work_order_revisions r ON r.order_id=w.id AND r.revision=w.latest_revision WHERE w.id=$1${lock ? ' FOR UPDATE OF w' : ''}`,
        [input.workOrderId],
      )
    ).rows[0] as { latest_revision: number; config: WorkOrderConfig } | undefined;
    if (!current || current.latest_revision !== input.workOrderRevision)
      fail('SANDBOX_WORK_ORDER_CHANGED');
    const config = current.config;
    if (
      config.operation !== 'update' ||
      config.connectionId !== input.connectionId ||
      config.itemId !== input.itemId ||
      config.productKey !== input.productKey ||
      config.sourceRevision !== input.sourceRevision ||
      !matches([...config.fieldMask].sort(), [...input.fieldMask].sort())
    )
      fail('SANDBOX_WORK_ORDER_MISMATCH');
    if (lock)
      await query.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'sandbox-target:' + input.connectionId + ':' + input.itemId,
      ]);
  }
  private async context(input: SandboxScopeInput, pinnedSource = false) {
    const row = (
      await this.repo.pool.query('SELECT * FROM connections WHERE id=$1', [input.connectionId])
    ).rows[0];
    if (
      !row ||
      row.environment !== 'sandbox' ||
      row.partner_id !== '1232297' ||
      row.shop_id !== '227418363' ||
      input.itemId !== '803934364'
    )
      fail('SANDBOX_SCOPE_NOT_ALLOWED');
    if (row.state !== 'connected' || !row.token_ciphertext || !row.partner_key_ciphertext)
      fail('SANDBOX_CONNECTION_REQUIRED');
    const box = new SecretBox(this.options.encryptionKey ?? process.env.APP_ENCRYPTION_KEY ?? ''),
      scopeKey = `sandbox:${row.partner_id}:${row.shop_id}`;
    let secrets: { partnerKey: string; accessToken: string };
    try {
      secrets = z.object({ partnerKey: z.string().min(1), accessToken: z.string().min(1) }).parse({
        ...(box.open(row.partner_key_ciphertext, scopeKey) as object),
        ...(box.open(row.token_ciphertext, scopeKey) as object),
      });
    } catch {
      fail('SANDBOX_CONNECTION_REQUIRED');
    }
    const credentials: ShopCredentials = {
      environment: 'sandbox',
      partnerId: row.partner_id,
      shopId: row.shop_id,
      ...secrets!,
    };
    const draft = await this.repo.getProduct(
      input.productKey,
      pinnedSource ? input.sourceRevision : undefined,
    );
    if (!draft || draft.revision !== input.sourceRevision) fail('SANDBOX_SOURCE_REVISION_CHANGED');
    return {
      client: new SandboxProductClient(credentials, this.options.transport),
      draft,
      scope: {
        environment: 'sandbox' as const,
        partnerId: row.partner_id as string,
        shopId: row.shop_id as string,
        connectionRevision: row.revision as number,
      },
    };
  }
  private async verifyAssets(draft: ListingDraft, fields: SandboxField[]) {
    for (const key of selectedAssetKeys(draft, fields)) {
      const asset = draft.assets.find((a) => a.key === key) ?? fail('SANDBOX_SOURCE_ASSET_MISSING');
      const file = await this.repo.getImport(asset.key);
      if (
        !file ||
        file.kind !== 'image' ||
        file.status !== 'ready' ||
        file.sha256 !== asset.sha256 ||
        file.bytes !== asset.bytes
      )
        fail('SANDBOX_SOURCE_ASSET_MISMATCH');
      const bytes = await this.blobs.read(asset.sha256);
      if (
        bytes.length !== asset.bytes ||
        !['image/png', 'image/jpeg'].includes(asset.mime) ||
        bytes.length > 10_000_000
      )
        fail('SANDBOX_SOURCE_ASSET_MISMATCH');
      const body = z
        .object({ mime: z.string(), width: z.number(), height: z.number() })
        .safeParse(file.body);
      if (
        !body.success ||
        body.data.mime !== asset.mime ||
        body.data.width !== asset.width ||
        body.data.height !== asset.height
      )
        fail('SANDBOX_SOURCE_ASSET_MISMATCH');
    }
  }
  async read(raw: unknown): Promise<SandboxReadResult> {
    const input = scopeSchema.parse(raw),
      { client, draft, scope } = await this.context(input);
    const snapshot = outcome(await client.read(input.itemId));
    const limitsResult = await client.limits(snapshot.categoryId);
    const checks = structureChecks(draft, snapshot);
    if (limitsResult.kind !== 'success')
      checks.push({
        code: 'SANDBOX_LIMITS_UNAVAILABLE',
        field: 'limits',
        message: 'Chưa đọc được giới hạn hiện tại của shop/ngành hàng. Chưa thể chuẩn bị cập nhật.',
      });
    return {
      scope,
      snapshot,
      source: {
        productKey: draft.productKey,
        revision: draft.revision,
        title: draft.title.value,
        skus: draft.variants.map((v) => v.sku.value),
      },
      comparison: [
        { field: 'title', state: draft.title.value === snapshot.title ? 'equal' : 'different' },
        {
          field: 'description',
          state: draft.description.some((b) => b.type === 'image')
            ? 'media_mapping_required'
            : matches(draft.description, snapshot.description)
              ? 'equal'
              : 'different',
        },
        { field: 'gallery', state: 'media_mapping_required' },
      ],
      limits: limitsResult.kind === 'success' ? limitsResult.data : null,
      checks,
      capabilities: {
        title: 'available',
        description: 'requires_preflight',
        gallery: 'requires_preflight',
        cover: 'not_implemented',
        productionWrite: false,
        automaticTokenRefresh: false,
      },
    };
  }
  private async stored(id: string): Promise<Stored> {
    z.string().uuid().parse(id);
    return (
      (await this.repo.pool.query('SELECT * FROM sandbox_listing_runs WHERE id=$1', [id]))
        .rows[0] ?? fail('SANDBOX_RUN_NOT_FOUND')
    );
  }
  async get(id: string): Promise<SandboxRun> {
    return publicRun(await this.stored(id));
  }
  async prepare(raw: unknown): Promise<SandboxRun> {
    const input = prepareSchema.parse(raw),
      fingerprint = productFingerprint(input);
    const existing = (
      await this.repo.pool.query('SELECT * FROM sandbox_listing_runs WHERE id=$1', [input.id])
    ).rows[0] as Stored | undefined;
    if (existing) {
      if (existing.input_fingerprint !== fingerprint) fail('SANDBOX_IDEMPOTENCY_CONFLICT');
      return publicRun(existing);
    }
    await this.assertWorkOrder(input);
    const { client, draft, scope } = await this.context(input);
    const baseline = outcome(await client.read(input.itemId));
    if (baseline.fingerprint !== input.baselineFingerprint) fail('SANDBOX_BASELINE_CHANGED');
    const checks = structureChecks(draft, baseline);
    if (checks.length) fail(checks[0]!.code);
    const limits = outcome(await client.limits(baseline.categoryId));
    validateLimits(draft, baseline, input.fieldMask, limits);
    await this.verifyAssets(draft, input.fieldMask);
    const intent: Intent = { input, draft, connectionRevision: scope.connectionRevision, limits };
    const body: StoredBody = {
      phase: 'prepared',
      fieldMask: input.fieldMask,
      baseline,
      preview: input.fieldMask.map((field) => ({
        field,
        before: baseline[field],
        after:
          field === 'title'
            ? draft.title.value
            : field === 'description'
              ? sourceDescription(draft)
              : draft.galleryKeys.map((key) => ({
                  assetKey: key,
                  sha256: draft.assets.find((a) => a.key === key)!.sha256,
                })),
      })),
      uploads: [],
      result: null,
    };
    const saved = await transaction(this.repo.pool, async (c) => {
      // Match WorkOrderRepository.save lock order: order advisory/row, target, then run.
      await this.assertWorkOrder(input, c, true);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'sandbox-run:' + input.id,
      ]);
      const raced = (await c.query('SELECT * FROM sandbox_listing_runs WHERE id=$1', [input.id]))
        .rows[0] as Stored | undefined;
      if (raced) {
        if (raced.input_fingerprint !== fingerprint) fail('SANDBOX_IDEMPOTENCY_CONFLICT');
        return raced;
      }
      const row = (
        await c.query(
          "INSERT INTO sandbox_listing_runs(id,connection_id,item_id,product_key,source_revision,connection_revision,input_fingerprint,state,intent,body) VALUES($1,$2,$3,$4,$5,$6,$7,'prepared',$8,$9) RETURNING *",
          [
            input.id,
            input.connectionId,
            input.itemId,
            input.productKey,
            input.sourceRevision,
            scope.connectionRevision,
            fingerprint,
            JSON.stringify(intent),
            JSON.stringify(body),
          ],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO sandbox_listing_run_events(run_id,revision,state,code) VALUES($1,1,'prepared','PREPARED')",
        [input.id],
      );
      return row as Stored;
    });
    return publicRun(saved);
  }
  private async checkpoint(
    row: Stored,
    state: SandboxRun['state'],
    body: StoredBody,
    code: string,
  ): Promise<Stored> {
    return transaction(this.repo.pool, async (c) => {
      if (code === 'CLAIMED' || code === 'WRITE_INTENT') {
        const ownerKey = 'sandbox:1232297:227418363';
        await lockSandboxMutationLane(c, ownerKey);
        if (await sandboxMutationLaneBusy(c, ownerKey, { family: 'listing', id: row.id }))
          fail('SANDBOX_TARGET_BUSY');
        await this.assertWorkOrder(row.intent.input, c, true);
      }
      let updated;
      try {
        updated = (
          await c.query(
            'UPDATE sandbox_listing_runs SET revision=revision+1,state=$3,body=$4,updated_at=now() WHERE id=$1 AND revision=$2 RETURNING *',
            [row.id, row.revision, state, JSON.stringify(body)],
          )
        ).rows[0] as Stored | undefined;
      } catch (error) {
        if ((error as { code?: string }).code === '23505') fail('SANDBOX_TARGET_BUSY');
        throw error;
      }
      if (!updated) fail('SANDBOX_RUN_REVISION_CONFLICT');
      await c.query(
        'INSERT INTO sandbox_listing_run_events(run_id,revision,state,code) VALUES($1,$2,$3,$4)',
        [row.id, updated.revision, state, code],
      );
      return updated;
    });
  }
  private async final(
    row: Stored,
    state: SandboxRun['state'],
    code: string,
    message: string,
    extra: Partial<NonNullable<SandboxRun['result']>> = {},
  ) {
    return this.checkpoint(
      row,
      state,
      { ...row.body, phase: 'done', result: { code, message, requestIds: [], ...extra } },
      code,
    );
  }
  private patch(row: Stored): { patch: SelectiveItemPatch; expected: SandboxSnapshot } {
    const draft = row.intent.draft,
      fields = row.body.fieldMask,
      expected = structuredClone(row.body.baseline),
      patch: SelectiveItemPatch = { item_id: Number(row.item_id) };
    const mapped = (key: string, scene: 'normal' | 'desc') =>
      row.body.uploads.find((u) => u.assetKey === key && u.scene === scene)?.imageId ??
      fail('SANDBOX_MEDIA_MAPPING_MISSING');
    if (fields.includes('title')) {
      patch.item_name = draft.title.value;
      expected.title = draft.title.value;
    }
    if (fields.includes('gallery')) {
      patch.image = {
        image_id_list: draft.galleryKeys.map((k) => mapped(k, 'normal')),
        image_ratio: expected.gallery.ratio as '1:1' | '3:4',
      };
      expected.gallery = { imageIds: patch.image.image_id_list, ratio: patch.image.image_ratio };
      if (patch.image.image_ratio === '3:4') {
        // Shopee can replace the promotion cover when gallery is updated without this field.
        // Echo the viewed original cover to preserve it; it remains an unselected QC field.
        if (
          row.body.baseline.coverImageIds.length !== 1 ||
          !/^[A-Za-z0-9_-]{1,512}$/.test(row.body.baseline.coverImageIds[0] ?? '')
        )
          fail('SANDBOX_COVER_PRESERVATION_REQUIRED');
        patch.promotion_images = { image_id_list: [...row.body.baseline.coverImageIds] };
      }
    }
    if (fields.includes('description')) {
      const blocks: RemoteDescriptionBlock[] = draft.description.map((b) =>
        b.type === 'text' ? b : { type: 'image', imageId: mapped(b.assetKey, 'desc') },
      );
      if (blocks.some((b) => b.type === 'image') || expected.descriptionType === 'extended') {
        patch.description_type = 'extended';
        patch.description_info = {
          extended_description: {
            field_list: blocks.map((b) =>
              b.type === 'text'
                ? { field_type: 'text', text: b.text }
                : { field_type: 'image', image_info: { image_id: b.imageId } },
            ),
          },
        };
        expected.description = blocks;
        expected.descriptionType = 'extended';
      } else {
        patch.description_type = 'normal';
        patch.description = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
        expected.description = [{ type: 'text', text: patch.description }];
        expected.descriptionType = 'normal';
      }
    }
    expected.fingerprint = productFingerprint(snapshotContent(expected));
    return { patch, expected };
  }
  private async reusableUpload(
    row: Stored,
    asset: AssetRef,
    scene: 'normal' | 'desc',
    ratio: string | null,
  ) {
    const candidates = (
      await this.repo.pool.query(
        `SELECT r.id,u.value FROM sandbox_listing_runs r
       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.body->'uploads')='array' THEN r.body->'uploads' ELSE '[]'::jsonb END) u(value)
       WHERE r.connection_id=$1 AND u.value->>'sha256'=$2 AND u.value->>'scene'=$3
        AND ($3='desc' OR r.body->'baseline'->'gallery'->>'ratio'=$4)
        AND EXISTS(SELECT 1 FROM sandbox_listing_run_events e WHERE e.run_id=r.id AND e.code IN ('UPLOAD_RECORDED','UPLOAD_REUSED'))
       ORDER BY r.updated_at DESC,r.id DESC LIMIT 20`,
        [row.connection_id, asset.sha256, scene, ratio],
      )
    ).rows;
    for (const candidate of candidates) {
      const mapping = z
        .object({
          assetKey: z.string().min(1),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          scene: z.enum(['normal', 'desc']),
          imageId: z.string().min(1).max(512),
        })
        .safeParse(candidate.value);
      if (mapping.success)
        return { imageId: mapping.data.imageId, reusedFromRunId: candidate.id as string };
    }
    return null;
  }
  private async verification(row: Stored, client: SandboxProductClient): Promise<Stored> {
    if (!row.body.expected)
      return this.final(
        row,
        'rejected',
        'NO_WRITE_INTENT',
        'Chưa gửi yêu cầu cập nhật. Hãy chuẩn bị một lần thực hiện mới; ảnh đã tải có thể còn trong kho ảnh sandbox.',
      );
    const after = await client.read(row.item_id);
    if (after.kind !== 'success')
      return this.final(
        row,
        'unknown',
        'READBACK_UNAVAILABLE',
        'Chưa đọc lại được kết quả. Chỉ đọc đối chiếu lại, không gửi cập nhật lần nữa.',
      );
    const selectedFieldsMatch = fieldsMatch(after.data, row.body.expected, row.body.fieldMask),
      unselectedFieldsMatch = matches(
        preservation(after.data, row.body.fieldMask),
        preservation(row.body.baseline, row.body.fieldMask),
      ),
      coverNeedsReview =
        selectedFieldsMatch &&
        !unselectedFieldsMatch &&
        onlyCoverIdsDiffer(after.data, row.body.baseline, row.body.fieldMask);
    return this.final(
      row,
      selectedFieldsMatch && unselectedFieldsMatch ? 'verified' : 'unknown',
      selectedFieldsMatch && unselectedFieldsMatch
        ? 'READBACK_VERIFIED'
        : coverNeedsReview
          ? 'COVER_READBACK_REVIEW'
          : 'READBACK_MISMATCH',
      selectedFieldsMatch && unselectedFieldsMatch
        ? 'Đã đọc lại: các trường được chọn khớp nguồn; các trường còn lại khớp bản trước khi cập nhật.'
        : coverNeedsReview
          ? 'Shopee trả mã ảnh bìa khác bản trước khi gửi. Cần đối chiếu ảnh bìa; chưa xác minh toàn bộ kết quả và không tự gửi lại.'
          : 'Dữ liệu đọc lại chưa khớp hoàn toàn. Giữ kết quả để đối chiếu, không tự gửi lại.',
      {
        after: after.data,
        requestIds: [...(row.body.result?.requestIds ?? []), ...after.data.requestIds],
        selectedFieldsMatch,
        unselectedFieldsMatch,
      },
    );
  }
  async execute(raw: unknown): Promise<SandboxRun> {
    const input = changeSchema.parse(raw);
    let row = await this.stored(input.id);
    if (row.state !== 'prepared') return publicRun(row); // A replay never causes another write.
    if (row.revision !== input.expectedRevision) fail('SANDBOX_RUN_REVISION_CONFLICT');
    await this.assertWorkOrder(row.intent.input);
    const { client, draft, scope } = await this.context(row.intent.input);
    if (
      scope.connectionRevision !== row.intent.connectionRevision ||
      !matches(draft, row.intent.draft)
    )
      fail('SANDBOX_SOURCE_REVISION_CHANGED');
    row = await this.checkpoint(row, 'in_flight', { ...row.body, phase: 'claimed' }, 'CLAIMED');
    try {
      const before = outcome(await client.read(row.item_id));
      if (before.fingerprint !== row.body.baseline.fingerprint)
        return publicRun(
          await this.final(
            row,
            'drift',
            'BASELINE_CHANGED',
            'Link đã thay đổi từ khi xem trước. Chưa gửi cập nhật; cần đọc và đối chiếu bản mới.',
            { after: before, requestIds: before.requestIds },
          ),
        );
      validateLimits(
        draft,
        before,
        row.body.fieldMask,
        outcome(await client.limits(before.categoryId)),
      );
      await this.verifyAssets(draft, row.body.fieldMask);
      const assets: { asset: AssetRef; scene: 'normal' | 'desc' }[] = [];
      if (row.body.fieldMask.includes('gallery'))
        for (const key of draft.galleryKeys)
          assets.push({ asset: draft.assets.find((a) => a.key === key)!, scene: 'normal' });
      if (row.body.fieldMask.includes('description'))
        for (const b of draft.description)
          if (b.type === 'image')
            assets.push({ asset: draft.assets.find((a) => a.key === b.assetKey)!, scene: 'desc' });
      for (const { asset, scene } of assets) {
        if (row.body.uploads.some((u) => u.assetKey === asset.key && u.scene === scene)) continue;
        // verifyAssets has already checked the current source bytes, metadata and import IDs.
        const cached = await this.reusableUpload(row, asset, scene, before.gallery.ratio);
        if (cached) {
          row = await this.checkpoint(
            row,
            'in_flight',
            {
              ...row.body,
              phase: 'uploading',
              uploads: [
                ...row.body.uploads,
                { assetKey: asset.key, sha256: asset.sha256, scene, ...cached },
              ],
            },
            'UPLOAD_REUSED',
          );
          continue;
        }
        row = await this.checkpoint(
          row,
          'in_flight',
          { ...row.body, phase: 'uploading' },
          'UPLOAD_INTENT',
        );
        const upload = await client.upload(
          await this.blobs.read(asset.sha256),
          asset.mime,
          scene,
          scene === 'normal' ? (before.gallery.ratio as '1:1' | '3:4') : undefined,
        );
        if (upload.kind !== 'success')
          return publicRun(
            await this.final(
              row,
              'rejected',
              'MEDIA_UPLOAD_INCOMPLETE',
              'Chưa gửi cập nhật listing vì tải ảnh chưa hoàn tất. Không tự tải lại ảnh có kết quả chưa rõ.',
              {
                requestIds: upload.requestId ? [upload.requestId] : [],
                failure: {
                  stage: 'media_upload',
                  outcome: upload.kind,
                  ...(upload.kind === 'rejected'
                    ? { code: upload.code }
                    : { reason: upload.reason }),
                  ...(upload.httpStatus !== undefined ? { httpStatus: upload.httpStatus } : {}),
                  ...(upload.requestId ? { requestId: upload.requestId } : {}),
                },
              },
            ),
          );
        row = await this.checkpoint(
          row,
          'in_flight',
          {
            ...row.body,
            uploads: [
              ...row.body.uploads,
              { assetKey: asset.key, sha256: asset.sha256, scene, imageId: upload.data.imageId },
            ],
          },
          'UPLOAD_RECORDED',
        );
      }
      const prepared = this.patch(row);
      // Check drift again after potentially slow uploads, immediately before the write intent.
      const fresh = outcome(await client.read(row.item_id));
      if (fresh.fingerprint !== row.body.baseline.fingerprint)
        return publicRun(
          await this.final(
            row,
            'drift',
            'BASELINE_CHANGED',
            'Link đã thay đổi trong lúc chuẩn bị ảnh. Chưa gửi cập nhật listing.',
            { after: fresh, requestIds: fresh.requestIds },
          ),
        );
      const current = await this.context(row.intent.input);
      if (
        current.scope.connectionRevision !== row.intent.connectionRevision ||
        !matches(current.draft, row.intent.draft)
      )
        return publicRun(
          await this.final(
            row,
            'rejected',
            'SOURCE_OR_CONNECTION_CHANGED',
            'Bộ nguồn hoặc kết nối đã có phiên bản mới. Chưa gửi cập nhật listing.',
          ),
        );
      row = await this.checkpoint(
        row,
        'in_flight',
        { ...row.body, ...prepared, phase: 'write_intent' },
        'WRITE_INTENT',
      );
      if (fieldsMatch(fresh, prepared.expected, row.body.fieldMask))
        return publicRun(
          await this.final(
            row,
            'verified',
            'NO_CHANGE',
            'Các trường đã khớp nguồn. Không cần gửi yêu cầu cập nhật.',
            {
              after: fresh,
              selectedFieldsMatch: true,
              unselectedFieldsMatch: true,
              requestIds: fresh.requestIds,
            },
          ),
        );
      const result = await client.update(prepared.patch);
      if (result.kind === 'rejected')
        return publicRun(
          await this.final(
            row,
            'rejected',
            'SHOPEE_REJECTED:' + result.code,
            'Shopee từ chối yêu cầu. Chưa coi là cập nhật thành công.',
            { requestIds: result.requestId ? [result.requestId] : [] },
          ),
        );
      if (result.kind === 'unknown')
        return publicRun(
          await this.final(
            row,
            'unknown',
            'WRITE_OUTCOME_UNKNOWN',
            'Chưa biết Shopee đã nhận cập nhật hay chưa. Chỉ đọc lại để đối chiếu; không tự gửi lại.',
          ),
        );
      row = await this.checkpoint(
        row,
        'in_flight',
        {
          ...row.body,
          phase: 'readback',
          result: {
            code: 'WRITE_ACKNOWLEDGED',
            message: 'Shopee đã trả phản hồi; đang đọc lại.',
            requestIds: result.requestId ? [result.requestId] : [],
          },
        },
        'WRITE_ACKNOWLEDGED',
      );
      return publicRun(await this.verification(row, client));
    } catch (error) {
      if ((error as Error).message === 'SANDBOX_RUN_REVISION_CONFLICT') throw error;
      const writeMayHaveOccurred = ['write_intent', 'readback'].includes(row.body.phase);
      return publicRun(
        await this.final(
          row,
          writeMayHaveOccurred ? 'unknown' : 'rejected',
          writeMayHaveOccurred ? 'WRITE_OUTCOME_UNKNOWN' : 'PREFLIGHT_INTERRUPTED',
          writeMayHaveOccurred
            ? 'Cần đọc lại để xác định kết quả; không tự gửi lại.'
            : 'Chưa gửi cập nhật listing. Kiểm tra kết nối, nguồn và giới hạn trước khi chuẩn bị lại.',
        ),
      );
    }
  }
  async reconcile(raw: unknown): Promise<SandboxRun> {
    const input = changeSchema.parse(raw);
    const row = await this.stored(input.id);
    if (row.revision !== input.expectedRevision) fail('SANDBOX_RUN_REVISION_CONFLICT');
    const archived = await this.repo.pool.query(
      `SELECT 1 FROM sandbox_listing_reconciliations q JOIN sandbox_listing_runs r ON r.id=q.run_id
       WHERE r.id=$1 AND q.verified AND q.run_revision=r.revision
         AND q.run_input_fingerprint=r.input_fingerprint AND q.run_snapshot=to_jsonb(r) LIMIT 1`,
      [row.id],
    );
    if (archived.rowCount) fail('SANDBOX_RUN_ALREADY_RECONCILED');
    if (row.state === 'verified' || row.state === 'rejected' || row.state === 'drift')
      return publicRun(row);
    if (
      row.state !== 'unknown' &&
      !(row.state === 'in_flight' && Date.now() - row.updated_at.getTime() > 120000)
    )
      fail('SANDBOX_RUN_NOT_RECONCILABLE');
    const { client, scope } = await this.context(row.intent.input, true);
    // Reauthorization may advance connectionRevision; the exact sandbox partner/shop stays enforced.
    if (scope.environment !== 'sandbox') fail('SANDBOX_SCOPE_NOT_ALLOWED');
    return publicRun(await this.verification(row, client));
  }
}
