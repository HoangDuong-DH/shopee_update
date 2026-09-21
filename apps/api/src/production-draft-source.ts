import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import {
  canonicalJson,
  compileDescription,
  readKini,
  validateDraft,
  sourceListingIntent,
  type SourceRef,
  type Issue,
  type Fact,
  type ListingDraft,
  type PreparedDocument,
  type PreparedMedia,
  type CatalogRow,
  type WorkbookImport,
} from '@shopee/domain';
import type { Repository, BlobStore, ImportRecord } from '@shopee/persistence';
import { verifyProductionPriceCells } from './production-batch-price-proof.js';
import {
  projectResolvedPriceIssues,
  resolvedDuplicatePriceIssueKeys,
} from '../../../packages/domain/src/source/selected-price-issues.js';

const nonblank = z
  .string()
  .min(1)
  .max(4000)
  .refine((value) => !!value.trim());
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const dimensions = z
  .object({ length: integer.min(1), width: integer.min(1), height: integer.min(1) })
  .strict();
const attribute = z
  .object({
    attribute_id: integer.min(1),
    attribute_value_list: z
      .array(
        z
          .object({
            value_id: integer,
            original_value_name: nonblank.optional(),
            value_unit: nonblank.optional(),
          })
          .strict()
          .refine(
            (v) => v.value_id !== 0 || !!v.original_value_name,
            'Custom value requires its exact label',
          ),
      )
      .min(1),
  })
  .strict();
const logistics = z.array(z.object({ channelId: id, enabled: z.boolean() }).strict()).min(1);
const stockLocation = z
  .object({
    referenceItemId: id,
    expectedLocationBySku: z.record(nonblank, nonblank),
    writeLocationBySku: z.record(nonblank, nonblank.nullable()),
  })
  .strict();
export const productionExistingListingAuthorizationSchema = z
  .object({
    reason: z.literal('distinct_prepared_listing_test'),
    authorizationReference: nonblank,
  })
  .strict();
export const productionDraftSourceInputSchema = z
  .object({
    productKey: nonblank,
    sourceRevision: integer.min(1),
    knowledgeAcceptanceId: z.string().uuid().optional(),
    existingListingAuthorization: productionExistingListingAuthorizationSchema.optional(),
    priceSelection: z
      .object({ importId: z.string().uuid(), sheet: nonblank, priceProfile: nonblank.nullable() })
      .strict(),
    stocks: z.record(nonblank, integer),
    choices: z
      .object({
        categoryId: id.optional(),
        brandId: z
          .string()
          .regex(/^(?:0|[1-9]\d*)$/)
          .refine((value) => Number.isSafeInteger(Number(value)))
          .optional(),
        brandName: nonblank.optional(),
        attributeList: z.array(attribute).optional(),
        logistics: logistics.optional(),
        weightGrams: z.number().finite().positive().optional(),
        dimensionCm: dimensions.optional(),
        condition: z.enum(['NEW', 'USED']).optional(),
        preOrder: z
          .object({ is_pre_order: z.boolean(), days_to_ship: integer.min(1).optional() })
          .strict()
          .optional(),
        stockLocation: stockLocation.optional(),
      })
      .strict(),
  })
  .strict();
export type ProductionDraftSourceInput = z.infer<typeof productionDraftSourceInputSchema>;
export type ProductionDraftPriceProof = {
  sku: string;
  importId: string;
  rowKey: string;
  sheetName: string;
  priceProfile: string | null;
  fileSha256: string;
  skuCell: string;
  priceCell: string;
  originalPrice: string;
};
export type ProductionDraftAsset = PreparedMedia & { filename: string; bytes: Uint8Array };
export type ProductionDraftSourceSnapshot = {
  version: 1;
  draft: ListingDraft;
  input: ProductionDraftSourceInput;
  decisionSource: SourceRef;
  imports: {
    id: string;
    sha256: string;
    filename: string;
    kind: ImportRecord['kind'];
    bytes: number;
  }[];
};
export type ProductionDraftSourceResult =
  | { kind: 'blocked'; issues: Issue[] }
  | {
      kind: 'ready';
      document: PreparedDocument;
      proposedAttributeList: z.infer<typeof attribute>[];
      brandName: string;
      condition: 'NEW' | 'USED';
      preOrder: { is_pre_order: boolean; days_to_ship?: number };
      stockLocation: z.infer<typeof stockLocation>;
      existingListingAuthorization?: z.infer<typeof productionExistingListingAuthorizationSchema>;
      priceProof: ProductionDraftPriceProof[];
      assets: ProductionDraftAsset[];
      sourceSnapshot: ProductionDraftSourceSnapshot;
      sourceFingerprint: string;
      issues: Issue[];
    };
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const active = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  (typeof value !== 'object' || Object.keys(value).length > 0);
const money = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[1-9]\d*$/.test(value) &&
  BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
const grams = (value: unknown) =>
  typeof value === 'string' &&
  /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) &&
  Number.isFinite(Number(value)) &&
  Number(value) > 0
    ? Number(value)
    : undefined;
const draftKeys = new Set([
  // Server-owned intake provenance; it changes no product fields or writer permissions.
  'folderSource',
  'sourceListingId',
  'productKey',
  'revision',
  'sourceSelection',
  'title',
  'description',
  'coverKey',
  'galleryKeys',
  'tierNames',
  'variants',
  'assets',
  'categoryId',
  'brandId',
  'attributes',
  'logistics',
  'videoKeys',
  'sizeChartKey',
  'identifiers',
  'compliance',
  'fulfillment',
  'publication',
  'issues',
]);
const variantKeys = new Set([
  'key',
  'sku',
  'optionLabels',
  'originalPrice',
  'promotionTarget',
  'imageKey',
  'declaredWeightGrams',
]);

/** Converts an exact saved source revision. No source edits, membership inference, network calls,
 * credential access, stock top-up, or Shopee writes. Extra operating choices stay in the receipt. */
export async function buildProductionDraftSource(
  repo: Pick<Repository, 'getProduct' | 'getImport'>,
  blobs: Pick<BlobStore, 'read'>,
  raw: unknown,
  decisionSource: SourceRef,
): Promise<ProductionDraftSourceResult> {
  const issues: Issue[] = [];
  const add = (
    code: string,
    field: string,
    message: string,
    sources: SourceRef[] = [],
    severity: Issue['severity'] = 'block',
  ) => issues.push({ code, field, message, sources: structuredClone(sources), severity });
  const blocked = (): ProductionDraftSourceResult => ({ kind: 'blocked', issues });
  const parsed = productionDraftSourceInputSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      add(
        'OPERATING_INPUT_INVALID',
        issue.path.join('.') || 'input',
        'Lựa chọn ngoài cấu trúc được hỗ trợ hoặc chưa hợp lệ.',
      );
    return blocked();
  }
  const input = parsed.data;
  if (
    decisionSource?.kind !== 'user_decision' ||
    !decisionSource.locator?.trim() ||
    !decisionSource.fileSha256 ||
    !Number.isFinite(Date.parse(decisionSource.observedAt))
  ) {
    add(
      'DECISION_PROVENANCE_REQUIRED',
      'choices',
      'Lựa chọn vận hành cần có nguồn quyết định của người dùng.',
    );
    return blocked();
  }
  let draft: ListingDraft | null;
  try {
    draft = await repo.getProduct(input.productKey, input.sourceRevision);
  } catch {
    add('SOURCE_UNAVAILABLE', 'sourceRevision', 'Chưa đọc được đúng phiên bản bộ nguồn.');
    return blocked();
  }
  if (!draft || draft.productKey !== input.productKey || draft.revision !== input.sourceRevision) {
    add(
      'SOURCE_REVISION_MISMATCH',
      'sourceRevision',
      'Không tìm thấy đúng phiên bản bộ nguồn đã chọn.',
    );
    return blocked();
  }
  draft = structuredClone(draft);
  for (const key of Object.keys(draft))
    if (!draftKeys.has(key) && active((draft as any)[key]))
      add('UNSUPPORTED_SOURCE_FIELD', key, 'Trường nguồn này chưa được hỗ trợ; không được bỏ qua.');
  for (const field of [
    'videoKeys',
    'sizeChartKey',
    'identifiers',
    'compliance',
    'fulfillment',
  ] as const)
    if (active(draft[field]))
      add('UNSUPPORTED_SOURCE_FIELD', field, 'Nguồn có dữ liệu chưa được luồng đăng này hỗ trợ.');
  if (draft.publication && draft.publication.value !== 'unlisted')
    add(
      'UNSUPPORTED_SOURCE_FIELD',
      'publication',
      'Yêu cầu trạng thái nguồn cần được xử lý riêng, không tự thay đổi.',
    );
  issues.push(...structuredClone(draft.issues));
  try {
    issues.push(...validateDraft(draft));
  } catch {
    add('SAVED_SOURCE_INVALID', 'source', 'Cấu trúc nguồn đã lưu chưa đầy đủ.');
    return blocked();
  }
  const confirmed = (value: Fact<unknown> | undefined, field: string) => {
    if (
      !value ||
      value.confirmed !== true ||
      !Array.isArray(value.sources) ||
      !value.sources.length
    ) {
      add('UNCONFIRMED_FACT', field, 'Thông tin nguồn chưa được xác nhận.', value?.sources ?? []);
      return false;
    }
    return true;
  };
  confirmed(draft.title, 'title');
  if (draft.sourceListingId) {
    confirmed(draft.sourceListingId, 'sourceListingId');
    const intent = sourceListingIntent(draft.sourceListingId.value);
    if (intent.kind === 'invalid')
      add(
        'SOURCE_LISTING_ID_INVALID',
        'sourceListingId',
        'ID LISTING trong nguồn không hợp lệ. Không chuyển thành đăng mới.',
        draft.sourceListingId.sources,
      );
    // Historical declarations remain readable in frozen manifests. Free-form text is
    // not a grant to compile a new create from a source targeting an existing item.
    if (intent.kind === 'update')
      add(
        'EXISTING_LISTING_REQUIRES_UPDATE',
        'sourceListingId',
        `Nguồn đã có ID ${intent.itemId}: cần cập nhật đúng link này, không tạo listing mới.`,
        draft.sourceListingId.sources,
      );
  }
  for (const field of ['categoryId', 'brandId', 'publication'] as const)
    if (draft[field]) confirmed(draft[field], field);
  for (const [key, value] of Object.entries(draft.attributes))
    confirmed(value, 'attributes.' + key);
  for (const [key, value] of Object.entries(draft.logistics)) confirmed(value, 'logistics.' + key);
  for (const [index, variant] of draft.variants.entries()) {
    for (const key of Object.keys(variant))
      if (!variantKeys.has(key) && active((variant as any)[key]))
        add(
          'UNSUPPORTED_SOURCE_FIELD',
          `variants.${index}.${key}`,
          'Trường nguồn phân loại này chưa được hỗ trợ; không được bỏ qua.',
        );
    confirmed(variant.sku, 'variants.' + index + '.sku');
    confirmed(variant.originalPrice, 'variants.' + index + '.originalPrice');
    if (variant.declaredWeightGrams)
      confirmed(variant.declaredWeightGrams, 'variants.' + index + '.declaredWeightGrams');
    if (!money(variant.originalPrice.value))
      add(
        'PRICE_INVALID',
        'variants.' + index + '.originalPrice',
        'Giá gốc phải là số đồng nguyên, dương, không tự làm tròn.',
        variant.originalPrice.sources,
      );
  }
  const selection = draft.sourceSelection;
  if (!selection) {
    add(
      'SOURCE_SELECTION_REQUIRED',
      'sourceSelection',
      'Bộ nguồn chưa có ánh xạ tệp và dòng giá đã lưu.',
    );
    return blocked();
  }
  if (
    !same(selection.sourceListingId ?? null, draft.sourceListingId?.value ?? null) ||
    !same(selection.title, draft.title.value) ||
    !same(selection.tierNames, draft.tierNames) ||
    !same(selection.coverId ?? '', draft.coverKey) ||
    !same(selection.galleryIds, draft.galleryKeys) ||
    !same(
      compileDescription(selection.headline, selection.body, selection.descriptionImageIds),
      draft.description,
    ) ||
    selection.variants.length !== draft.variants.length ||
    selection.variants.some(
      (v, i) =>
        !same(v.optionLabels, draft.variants[i]?.optionLabels) ||
        !same(v.imageId, draft.variants[i]?.imageKey),
    )
  )
    add(
      'SAVED_MAPPING_MISMATCH',
      'sourceSelection',
      'Nội dung hoặc vai trò ảnh/phân loại lệch ánh xạ đã lưu.',
    );
  if (
    draft.tierNames.length > 2 ||
    draft.variants.length > 100 ||
    (!draft.tierNames.length && draft.variants.length !== 1) ||
    new Set(draft.tierNames).size !== draft.tierNames.length
  )
    add(
      'UNSUPPORTED_VARIANT_STRUCTURE',
      'variations',
      'Cấu trúc phân loại chưa được luồng này hỗ trợ.',
    );

  const records = new Map<string, ImportRecord>();
  const checkedBytes = new Map<string, Uint8Array>();
  async function imported(importId: string, kind: ImportRecord['kind']) {
    if (!z.string().uuid().safeParse(importId).success) {
      add('SOURCE_IMPORT_INVALID', 'sourceSelection', 'Mã tệp nguồn không hợp lệ.');
      return null;
    }
    if (records.has(importId)) {
      const cached = records.get(importId)!;
      if (cached.kind === kind) return cached;
      add(
        'SOURCE_IMPORT_INVALID',
        'imports.' + importId,
        'Một tệp đang bị dùng sai vai trò nguồn.',
      );
      return null;
    }
    try {
      const record = await repo.getImport(importId);
      if (!record || record.kind !== kind || record.status !== 'ready') throw Error();
      const bytes = await blobs.read(record.sha256);
      if (hash(bytes) !== record.sha256 || bytes.byteLength !== record.bytes) throw Error();
      records.set(importId, record);
      checkedBytes.set(importId, bytes);
      return record;
    } catch {
      add(
        'SOURCE_BYTES_UNAVAILABLE',
        'imports.' + importId,
        'Tệp nguồn chưa sẵn sàng hoặc byte/hash không khớp.',
      );
      return null;
    }
  }
  const workbookRecord = await imported(input.priceSelection.importId, 'xlsx');
  let reread: WorkbookImport | undefined;
  if (workbookRecord) {
    try {
      reread = await readKini(checkedBytes.get(workbookRecord.id)!, workbookRecord.filename);
    } catch {
      add(
        'PRICE_BYTES_UNREADABLE',
        'priceSelection',
        'Không đọc được workbook gốc để đối chiếu giá.',
      );
    }
  }
  const priceProof: ProductionDraftPriceProof[] = [];
  const weights = new Map<string, number>();
  const sourceBrands: Fact<string>[] = [];
  const resolvedPriceIssues = new Set<string>();
  function cell(fact: Fact<string>, row: CatalogRow, fileHash: string, field: string) {
    const matches = fact.sources.filter(
      (s) =>
        s.kind === 'product_file' &&
        s.fileSha256 === fileHash &&
        s.locator.startsWith(row.sheet + '!') &&
        /^[A-Z]+[1-9]\d*$/.test(s.locator.slice(row.sheet.length + 1)),
    );
    if (matches.length !== 1) {
      add(
        'PRICE_CELL_PROVENANCE_REQUIRED',
        field,
        'Chưa xác định duy nhất ô nguồn của SKU/giá.',
        fact.sources,
      );
      return null;
    }
    return matches[0]!.locator.slice(row.sheet.length + 1);
  }
  for (const [index, variant] of draft.variants.entries()) {
    const priceIssueStart = issues.length;
    const selected = selection.variants[index];
    if (!selected || selected.importId !== input.priceSelection.importId) {
      add('PRICE_SCOPE_MISMATCH', 'priceSelection', 'Phân loại không thuộc workbook đã chọn.');
      continue;
    }
    if (!workbookRecord || !reread) continue;
    const stored =
      (workbookRecord.body as WorkbookImport)?.rows?.filter((row) => row.key === selected.rowKey) ??
      [];
    const actual = reread.rows.filter((row) => row.key === selected.rowKey);
    if (stored.length !== 1 || actual.length !== 1) {
      add(
        'PRICE_ROW_AMBIGUOUS',
        'variants.' + index,
        'Dòng giá đã lưu không tồn tại duy nhất trong nguồn.',
      );
      continue;
    }
    const row = stored[0]!,
      fresh = actual[0]!;
    if (
      row.sheet !== input.priceSelection.sheet ||
      (row.priceProfile ?? null) !== input.priceSelection.priceProfile ||
      fresh.sheet !== row.sheet ||
      fresh.priceProfile !== row.priceProfile
    )
      add(
        'PRICE_SCOPE_MISMATCH',
        'priceSelection',
        'Dòng giá không thuộc sheet/bộ giá được chỉ định.',
      );
    if (
      row.sku.value !== variant.sku.value ||
      row.originalPrice?.value !== variant.originalPrice.value ||
      variant.key !== selected.rowKey
    )
      add(
        'SAVED_PRICE_MISMATCH',
        'variants.' + index,
        'SKU hoặc giá đã lưu lệch dòng nguồn được chọn.',
      );
    if (
      fresh.sku.value !== row.sku.value ||
      fresh.originalPrice?.value !== row.originalPrice?.value ||
      fresh.declaredWeightGrams?.value !== row.declaredWeightGrams?.value ||
      fresh.brand?.value !== row.brand?.value
    )
      add(
        'PRICE_BYTES_MISMATCH',
        'variants.' + index,
        'Giá/SKU/cân nặng trong workbook gốc lệch dữ liệu đã lưu.',
      );
    issues.push(...structuredClone(row.issues), ...structuredClone(fresh.issues));
    confirmed(row.sku, 'priceSelection.sku');
    confirmed(row.originalPrice, 'priceSelection.originalPrice');
    if (row.brand) {
      confirmed(row.brand, 'brandName');
      sourceBrands.push(row.brand);
    }
    if (row.originalPrice) {
      const skuCell = cell(row.sku, row, workbookRecord.sha256, 'priceSelection.sku'),
        priceCell = cell(
          row.originalPrice,
          row,
          workbookRecord.sha256,
          'priceSelection.originalPrice',
        );
      if (
        skuCell !== cell(fresh.sku, fresh, workbookRecord.sha256, 'priceSelection.sku') ||
        !fresh.originalPrice ||
        priceCell !==
          cell(fresh.originalPrice, fresh, workbookRecord.sha256, 'priceSelection.originalPrice')
      )
        add(
          'PRICE_CELL_PROVENANCE_MISMATCH',
          'variants.' + index,
          'Ô nguồn đã lưu lệch vị trí đọc trực tiếp từ workbook gốc.',
          row.originalPrice.sources,
        );
      if (skuCell && priceCell)
        priceProof.push({
          sku: variant.sku.value,
          importId: workbookRecord.id,
          rowKey: row.key,
          sheetName: row.sheet,
          priceProfile: row.priceProfile ?? null,
          fileSha256: workbookRecord.sha256,
          skuCell,
          priceCell,
          originalPrice: variant.originalPrice.value,
        });
    }
    if (variant.declaredWeightGrams) {
      const weight = grams(variant.declaredWeightGrams.value);
      if (
        !weight ||
        variant.declaredWeightGrams.value !== row.declaredWeightGrams?.value ||
        row.declaredWeightGrams?.confirmed !== true
      )
        add(
          'WEIGHT_SOURCE_MISMATCH',
          'variants.' + index + '.declaredWeightGrams',
          'Cân nặng đã lưu chưa khớp nguồn gram đã xác nhận.',
          variant.declaredWeightGrams.sources,
        );
      else weights.set(variant.sku.value, weight);
    } else if (row.declaredWeightGrams)
      add(
        'WEIGHT_MAPPING_MISSING',
        'variants.' + index + '.declaredWeightGrams',
        'Nguồn có cân nặng nhưng bản listing chưa ánh xạ, cần lưu phiên bản nguồn đầy đủ.',
      );
    if (
      variant.sku.confirmed &&
      variant.originalPrice.confirmed &&
      !issues.slice(priceIssueStart).some((issue) => issue.severity === 'block')
    ) {
      const storedKeys = resolvedDuplicatePriceIssueKeys(
        (workbookRecord.body as WorkbookImport).rows,
        selected.rowKey,
      );
      const freshKeys = resolvedDuplicatePriceIssueKeys(reread.rows, selected.rowKey);
      // Both the persisted row and immutable original bytes must resolve this selection.
      if (storedKeys.size && freshKeys.size)
        for (const key of [...storedKeys, ...freshKeys]) resolvedPriceIssues.add(key);
    }
  }
  if (workbookRecord && priceProof.length) {
    try {
      await verifyProductionPriceCells(checkedBytes.get(workbookRecord.id)!, priceProof);
    } catch {
      resolvedPriceIssues.clear();
      add(
        'PRICE_CELL_BYTES_MISMATCH',
        'priceSelection',
        'Giá hoặc cách viết SKU tại ô gốc không khớp chính xác; cần xử lý ánh xạ nguồn trước khi đăng.',
      );
    }
  }
  const unresolvedPriceIssues = projectResolvedPriceIssues(issues, resolvedPriceIssues);
  issues.splice(0, issues.length, ...unresolvedPriceIssues);
  const skus = draft.variants.map((v) => v.sku.value);
  if (!same([...Object.keys(input.stocks)].sort(), [...skus].sort()))
    add(
      'STOCK_SCOPE_MISMATCH',
      'stocks',
      'Phải chỉ định tồn cho đúng từng SKU, kể cả tồn bằng 0.',
      [decisionSource],
    );
  const chosen = input.choices;
  for (const field of ['categoryId', 'brandId'] as const)
    if (draft[field] && chosen[field] !== undefined && draft[field]!.value !== chosen[field])
      add(
        'CONFIRMED_FACT_CONFLICT',
        field,
        'Lựa chọn khác dữ kiện đã xác nhận; cần sửa nguồn bằng phiên bản riêng.',
        draft[field]!.sources,
      );
  const categoryId = draft.categoryId?.value ?? chosen.categoryId,
    brandId = draft.brandId?.value ?? chosen.brandId;
  if (categoryId !== undefined && !id.safeParse(categoryId).success)
    add(
      'SOURCE_ID_INVALID',
      'categoryId',
      'Mã ngành nguồn không hợp lệ.',
      draft.categoryId?.sources ?? [],
    );
  if (
    brandId !== undefined &&
    !productionDraftSourceInputSchema.shape.choices.shape.brandId.safeParse(brandId).success
  )
    add(
      'SOURCE_ID_INVALID',
      'brandId',
      'Mã thương hiệu nguồn không hợp lệ.',
      draft.brandId?.sources ?? [],
    );
  const brandNames = [...new Set(sourceBrands.map((f) => f.value))];
  if (
    brandNames.length > 1 ||
    (chosen.brandName !== undefined && brandNames.some((name) => name !== chosen.brandName))
  )
    add(
      'CONFIRMED_FACT_CONFLICT',
      'brandName',
      'Tên thương hiệu khác nguồn đã xác nhận; không được tự thay thương hiệu.',
      sourceBrands.flatMap((f) => f.sources),
    );
  const brandName =
    chosen.brandName ??
    (sourceBrands.length === skus.length && brandNames.length === 1 ? brandNames[0] : undefined);
  const savedLogistics = Object.entries(draft.logistics).map(([channelId, fact]) => ({
    channelId,
    enabled: fact.value,
  }));
  const recoveredLogistics = logistics.safeParse(savedLogistics);
  const chosenLogistics =
    chosen.logistics ?? (recoveredLogistics.success ? recoveredLogistics.data : undefined);
  for (const [field, value] of Object.entries({
    categoryId,
    brandId,
    brandName,
    logistics: chosenLogistics,
    dimensionCm: chosen.dimensionCm,
    condition: chosen.condition,
    preOrder: chosen.preOrder,
    stockLocation: chosen.stockLocation,
  }))
    if (value === undefined)
      add('OPERATING_FIELD_REQUIRED', field, 'Cần bổ sung thông tin vận hành có nguồn.', [
        decisionSource,
      ]);
  if (
    chosen.stockLocation &&
    (!same([...Object.keys(chosen.stockLocation.expectedLocationBySku)].sort(), [...skus].sort()) ||
      !same([...Object.keys(chosen.stockLocation.writeLocationBySku)].sort(), [...skus].sort()))
  )
    add(
      'STOCK_LOCATION_SCOPE_MISMATCH',
      'stockLocation',
      'Ánh xạ kho phải có đúng các SKU của listing.',
    );
  const savedAttributes = Object.entries(draft.attributes).map(([key, fact]) => ({
    attribute_id: Number(key),
    attribute_value_list: (Array.isArray(fact.value) ? fact.value : [fact.value]).map((value) => ({
      value_id: typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN,
    })),
  }));
  const recoveredAttributes = z.array(attribute).safeParse(savedAttributes);
  const proposedAttributeList =
    chosen.attributeList ?? (recoveredAttributes.success ? recoveredAttributes.data : []);
  if (
    new Set(proposedAttributeList.map((a) => a.attribute_id)).size !==
      proposedAttributeList.length ||
    proposedAttributeList.some(
      (a) =>
        new Set(a.attribute_value_list.map((v) => v.value_id)).size !==
        a.attribute_value_list.length,
    )
  )
    add('ATTRIBUTE_MAPPING_INVALID', 'attributes', 'Thuộc tính hoặc giá trị bị trùng.');
  const attributes = Object.fromEntries(
    proposedAttributeList.map((a) => [
      String(a.attribute_id),
      a.attribute_value_list.map((v) => String(v.value_id)),
    ]),
  );
  for (const [key, fact] of Object.entries(draft.attributes)) {
    const value = Array.isArray(fact.value) ? fact.value : [fact.value];
    if (
      !value.every((v) => typeof v === 'string' && /^(?:0|[1-9]\d*)$/.test(v)) ||
      !same(value, attributes[key])
    )
      add(
        'CONFIRMED_FACT_CONFLICT',
        'attributes.' + key,
        'Thuộc tính nguồn chưa được ánh xạ chính xác; không bỏ hoặc thay giá trị.',
        fact.sources,
      );
  }
  if (
    chosenLogistics &&
    new Set(chosenLogistics.map((c) => c.channelId)).size !== chosenLogistics.length
  )
    add('LOGISTICS_MAPPING_INVALID', 'logistics', 'Kênh vận chuyển bị trùng.');
  for (const [key, fact] of Object.entries(draft.logistics))
    if (
      typeof fact.value !== 'boolean' ||
      chosenLogistics?.find((c) => c.channelId === key)?.enabled !== fact.value
    )
      add(
        'CONFIRMED_FACT_CONFLICT',
        'logistics.' + key,
        'Cấu hình vận chuyển đã xác nhận chưa được giữ nguyên.',
        fact.sources,
      );
  const itemWeight = chosen.weightGrams;
  if (itemWeight === undefined)
    add('OPERATING_FIELD_REQUIRED', 'weightGrams', 'Cần xác nhận cân nặng khai báo cấp listing.', [
      decisionSource,
    ]);
  if (weights.size && weights.size !== skus.length)
    add(
      'PARTIAL_MODEL_SHIPPING',
      'weightGrams',
      'Có cân nặng riêng ở một số SKU; cần xác nhận đủ cấu trúc vận chuyển trước khi đăng.',
    );
  if (
    weights.size === skus.length &&
    itemWeight !== undefined &&
    itemWeight !== Math.max(...weights.values())
  )
    add(
      'ITEM_WEIGHT_SOURCE_CONFLICT',
      'weightGrams',
      'Cân nặng cấp listing cần đối chiếu với trọng lượng lớn nhất của các SKU đã có nguồn.',
      [decisionSource],
    );
  if (chosen.preOrder?.is_pre_order && chosen.preOrder.days_to_ship === undefined)
    add(
      'OPERATING_FIELD_REQUIRED',
      'preOrder.days_to_ship',
      'Hàng đặt trước cần số ngày chuẩn bị có nguồn.',
      [decisionSource],
    );

  const usedKeys = [
    ...new Set([
      draft.coverKey,
      ...draft.galleryKeys,
      ...draft.description.flatMap((b) => (b.type === 'image' ? [b.assetKey] : [])),
      ...draft.variants.flatMap((v) => (v.imageKey ? [v.imageKey] : [])),
    ]),
  ];
  const assets: ProductionDraftAsset[] = [],
    media = new Map<string, PreparedMedia>();
  for (const key of usedKeys) {
    const descriptors = draft.assets.filter((a) => a.key === key),
      record = await imported(key, 'image');
    if (descriptors.length !== 1 || !record) {
      add(
        'ASSET_MAPPING_INVALID',
        'assets.' + key,
        'Ảnh được chọn phải có đúng một bản nguồn đã nhập.',
      );
      continue;
    }
    const asset = descriptors[0]!,
      data = checkedBytes.get(key)!;
    try {
      const metadata = await sharp(data).metadata();
      const mime =
        metadata.format === 'png' ? 'image/png' : metadata.format === 'jpeg' ? 'image/jpeg' : null;
      if (
        record.sha256 !== asset.sha256 ||
        record.bytes !== asset.bytes ||
        mime !== asset.mime ||
        metadata.width !== asset.width ||
        metadata.height !== asset.height ||
        (metadata.pages && metadata.pages !== 1) ||
        (metadata.orientation && metadata.orientation !== 1) ||
        asset.durationMs !== undefined
      )
        throw Error();
      const descriptor = {
        importId: key,
        sha256: asset.sha256,
        mime: asset.mime,
        width: asset.width,
        height: asset.height,
      };
      media.set(key, descriptor);
      assets.push({ ...descriptor, filename: record.filename, bytes: Uint8Array.from(data) });
    } catch {
      add(
        'ASSET_BYTES_MISMATCH',
        'assets.' + key,
        'Byte ảnh hoặc kích thước/định dạng thực tế không khớp bản đã lưu.',
        [asset.source],
      );
    }
  }
  if (issues.some((i) => i.severity === 'block')) return blocked();
  const options = draft.tierNames.map((_, tier) => [
    ...new Set(draft.variants.map((v) => v.optionLabels[tier]!)),
  ]);
  const sourceDescription = draft.description.some((block) => block.type === 'image')
    ? draft.description
    : (() => {
        const text = draft.description
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        const lines = text.split(/\r?\n/);
        const opening = lines.shift()?.trim() ?? '';
        const content = lines.join('\n').trim();
        return opening && content && draft.galleryKeys.length
          ? compileDescription(opening, content, draft.galleryKeys.slice(0, 9))
          : draft.description;
      })();
  const document: PreparedDocument = {
    sourceKey: draft.productKey,
    title: draft.title.value,
    description: sourceDescription.map((b) =>
      b.type === 'text' ? { ...b } : { type: 'image', image: media.get(b.assetKey)! },
    ),
    cover: media.get(draft.coverKey)!,
    gallery: draft.galleryKeys.map((key) => media.get(key)!),
    tierNames: [...draft.tierNames],
    models: draft.variants.map((v) => ({
      sku: v.sku.value,
      optionLabels: [...v.optionLabels],
      tierIndex: v.optionLabels.map((value, index) => options[index]!.indexOf(value)),
      originalPrice: v.originalPrice.value,
      stock: input.stocks[v.sku.value]!,
      ...(v.imageKey ? { image: media.get(v.imageKey)! } : {}),
      ...(draft.tierNames.length && weights.has(v.sku.value)
        ? {
            weightGrams: weights.get(v.sku.value)!,
            dimensionCm: structuredClone(chosen.dimensionCm!),
          }
        : {}),
    })),
    categoryId: categoryId!,
    brandId: brandId!,
    attributes,
    logistics: structuredClone(chosenLogistics!),
    weightGrams: itemWeight!,
    dimensionCm: structuredClone(chosen.dimensionCm!),
    publication: 'unlisted',
  };
  const sourceSnapshot: ProductionDraftSourceSnapshot = {
    version: 1,
    draft,
    input: structuredClone(input),
    decisionSource: structuredClone(decisionSource),
    imports: [...records.values()].map((r) => ({
      id: r.id,
      sha256: r.sha256,
      filename: r.filename,
      kind: r.kind,
      bytes: r.bytes,
    })),
  };
  return {
    kind: 'ready',
    document,
    proposedAttributeList: structuredClone(proposedAttributeList),
    brandName: brandName!,
    condition: chosen.condition!,
    preOrder: structuredClone(chosen.preOrder!),
    stockLocation: structuredClone(chosen.stockLocation!),
    ...(input.existingListingAuthorization
      ? { existingListingAuthorization: structuredClone(input.existingListingAuthorization) }
      : {}),
    priceProof,
    assets,
    sourceSnapshot,
    sourceFingerprint: hash(canonicalJson({ sourceSnapshot, document, priceProof })),
    issues,
  };
}
