import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { canonicalJson, eligibleProductChannels, productChannelIssue, type ListingDraft, type WorkbookImport } from '@shopee/domain';
import { assertDraftLocalSourcesActive, type Repository } from '@shopee/persistence';
import {
  productionDraftSourceInputSchema,
  type ProductionDraftSourceInput,
} from './production-draft-source.js';
import {
  ProductionPreparationMetadataService,
  type ProductionPreparationMetadata,
  type ProductionPreparationMetadataQuery,
} from './production-preparation-metadata.js';
import { productionPilotScope } from './production-pilot-source.js';
import { checkVerification } from './production-batch-runner.js';
import { normalizeSellerObservation } from './seller-knowledge-adapter.js';
import {
  recommendSellerKnowledge,
  type SellerKnowledgeAttributeMetadata,
  type SellerKnowledgeIssue,
  type SellerKnowledgeSuggestion,
} from '../../../packages/domain/src/seller-knowledge.js';

type Choices = ProductionDraftSourceInput['choices'];
const choiceSchema = productionDraftSourceInputSchema.shape.choices;
export const productionPreparationAutofillSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            productKey: z.string().min(1).max(4000),
            sourceRevision: z.number().int().positive(),
            categoryId: choiceSchema.shape.categoryId,
            brandId: choiceSchema.shape.brandId,
            dimensionCm: choiceSchema.shape.dimensionCm,
          })
          .strict(),
      )
      .min(1)
      .max(80),
    shared: choiceSchema.pick({ condition: true, preOrder: true, dimensionCm: true }).optional(),
    attributeMode: z.enum(['minimum_required', 'source_supported']).optional(),
    logisticsMode: z.enum(['source_supported', 'all_eligible']).optional(),
  })
  .strict()
  .refine(
    (v) => new Set(v.entries.map((e) => e.productKey)).size === v.entries.length,
    'Duplicate source',
  );
export type PreparationAutofillExplanation = {
  field: string;
  value?: unknown;
  message: string;
  source?: string;
};
export type PreparationAutofillEntry = {
  productKey: string;
  sourceRevision: number;
  choices: Choices;
  explanations: PreparationAutofillExplanation[];
  unresolved: { field: string; message: string }[];
  issues: { code: string; message: string }[];
  metadata?: ProductionPreparationMetadata;
  knowledgeIssues?: SellerKnowledgeIssue[];
  knowledgeSuggestions?: Array<
    SellerKnowledgeSuggestion & {
      applied: boolean;
      references: { itemId: string; title: string; evidenceId: string }[];
    }
  >;
};
export type ProductionPreparationAutofillResult = {
  attributeMode: 'minimum_required' | 'source_supported';
  scope: typeof productionPilotScope;
  connectionRevision: number;
  observedAt: string;
  fingerprint: string;
  entries: PreparationAutofillEntry[];
  auditPath?: string;
};
type Options = {
  metadata?: (query: ProductionPreparationMetadataQuery) => Promise<ProductionPreparationMetadata>;
  now?: () => number;
  auditRoot?: string | false;
};
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const normalize = (v: string) =>
  v
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const fail = (code: string): never => {
  throw Error('PRODUCTION_PREPARATION_' + code);
};
const supportedId = (v: unknown) =>
  typeof v === 'string' && /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v));
function sourceFamily(title: string): 'floor' | 'candle' | 'room' | 'special' | null {
  const text = normalize(title);
  if (/\bnuoc lau san\b/.test(text)) return 'floor';
  if (/^nen (thom|thao moc|khu mui|trai cay)\b/.test(text)) return 'candle';
  // Shoe and vehicle uses need their own category evidence; a shared oil SKU is insufficient.
  if (/\b(giay|xe|o to|treo)\b/.test(text)) return 'special';
  if (/^xit (khu mui|thom|tinh dau)\b/.test(text)) return 'room';
  return null;
}
function corroboratedRoomSource(
  draft: ListingDraft,
  rows: Array<{ name?: unknown } | null>,
): boolean {
  const title = normalize(draft.title.value);
  // This extension handles title word order only. It must not turn a surface cleaner,
  // shoe/vehicle spray, or candle into a room fragrance because of shared oil SKUs.
  if (
    !/\bxit\b/.test(title) ||
    !/\b(phong|sofa|rem|dem|nha tam|ve sinh)\b/.test(title) ||
    /\b(giay|xe|o to|treo|nen|nuoc lau|dung dich lau|xit lau|lau ban|lau bep|tay rua)\b/.test(title)
  )
    return false;
  if (
    rows.length !== draft.variants.length ||
    !rows.length ||
    !rows.every(
      (row) =>
        knownFact(row?.name) && /\bxit\b/.test(normalize((row!.name as { value: string }).value)),
    )
  )
    return false;
  return draft.description.some(
    (block) =>
      block.type === 'text' &&
      block.text.split(/\r?\n/).some((line) => {
        const text = normalize(line);
        return (
          /\bxit\b/.test(text) &&
          /\b(phong|sofa|rem|dem|ga|goi|nha tam|ve sinh)\b/.test(text) &&
          !/^(khong|tranh|chua)\b/.test(text)
        );
      }),
  );
}
function corroboratedAdditionalFamily(
  draft: ListingDraft,
  rows: Array<{ name?: unknown } | null>,
): 'room' | 'car' | 'cleaner' | null {
  if (
    !rows.length ||
    rows.length !== draft.variants.length ||
    !rows.every((row) => knownFact(row?.name))
  )
    return null;
  const title = normalize(draft.title.value),
    names = rows.map((row) => normalize((row!.name as { value: string }).value));
  const lines = draft.description
    .flatMap((block) => (block.type === 'text' ? block.text.split(/\r?\n/).map(normalize) : []))
    .filter((line) => !/^(khong|tranh|chua)\b/.test(line));
  const allSpray = names.every((name) => /\bxit\b/.test(name));
  if (
    allSpray &&
    /\bxit\b/.test(title) &&
    /\b(o to|khoang xe)\b/.test(title) &&
    lines.some(
      (line) => /\bxit\b/.test(line) && /\b(khoang xe|ghe xe|noi that xe|trong xe)\b/.test(line),
    )
  )
    return 'car';
  if (
    allSpray &&
    /\bxit\b/.test(title) &&
    /\b(tu giay|ke giay)\b/.test(title) &&
    lines.some(
      (line) =>
        /\bxit\b/.test(line) &&
        /\b(long (ngan )?tu|ngan tu|khoang tu|hoc tu|vach go|ke giay)\b/.test(line),
    )
  )
    return 'room';
  if (
    /\b(dung dich lau|chai xit lau|lau da nang)\b/.test(title) &&
    names.every((name) => /^dung dich\b/.test(name)) &&
    lines.some(
      (line) =>
        /\b(lau|xit|dung dich)\b/.test(line) && /\b(mat ban|mat bep|tay nam cua)\b/.test(line),
    )
  )
    return 'cleaner';
  return null;
}
function categoryFromSource(
  family: ReturnType<typeof sourceFamily> | 'car' | 'cleaner',
  metadata: ProductionPreparationMetadata,
) {
  const matches = metadata.categories.filter((c) => {
    const label = normalize(c.label);
    return family === 'floor' || family === 'cleaner'
      ? label === 'chat tay rua'
      : family === 'candle'
        ? /^nen (va |do |$)/.test(label)
        : family === 'car'
          ? label === 'nuoc hoa xe'
          : family === 'room'
            ? label === 'chat khu mui lam thom'
            : false;
  });
  return matches.length === 1 ? matches[0]!.id : undefined;
}
function knownFact(f: any): boolean {
  return (
    !!f?.confirmed &&
    Array.isArray(f.sources) &&
    f.sources.some(
      (s: any) =>
        ['product_file', 'user_decision'].includes(s.kind) &&
        /^[a-f0-9]{64}$/.test(s.fileSha256) &&
        typeof s.locator === 'string' &&
        s.locator.trim(),
    )
  );
}
function checkedHistory(row: any, connection: any) {
  try {
    const op = row.operation,
      payload = op?.source_payload;
    if (
      !op ||
      op.state !== 'verified' ||
      !supportedId(op.item_id) ||
      op.connection_id !== connection.id ||
      op.owner_key !==
        `production:${productionPilotScope.partnerId}:${productionPilotScope.shopId}` ||
      !Number.isInteger(op.connection_revision) ||
      op.connection_revision < 1 ||
      op.connection_revision > connection.revision ||
      payload?.connectionId !== connection.id ||
      payload?.connectionRevision !== op.connection_revision ||
      payload?.sourceIdentity !== op.source_identity ||
      payload?.sourceRevision !== op.source_revision ||
      !Array.isArray(payload?.document?.logistics) ||
      op.source_fingerprint !==
        hash({
          scope: productionPilotScope,
          sourceIdentity: op.source_identity,
          sourceRevision: op.source_revision,
          sourcePayload: payload,
          expectedProjection: op.expected_projection,
        })
    )
      return false;
    checkVerification(
      row.verification,
      op.id,
      op.revision,
      op.item_id,
      'created_unlisted',
      op.expected_projection,
    );
    return true;
  } catch {
    return false;
  }
}

/** Suggestions only: never stores a draft, grants publication permission, or issues a Shopee write.
 * Source facts outrank history. Preview/register still recheck current sources and live metadata. */
export class ProductionPreparationAutofillService {
  constructor(
    private readonly repo: Repository,
    private readonly options: Options = {},
  ) {}
  async recommend(raw: unknown, signal?: AbortSignal): Promise<ProductionPreparationAutofillResult> {
    signal?.throwIfAborted();
    const input = productionPreparationAutofillSchema.safeParse(raw);
    if (!input.success) throw Error('PRODUCTION_PREPARATION_QUERY_INVALID');
    const request = input.data;
    const attributeMode = request.attributeMode ?? 'source_supported';
    const now = this.options.now ?? Date.now;
    const connection = async () => {
      signal?.throwIfAborted();
      const rows = (
        await this.repo.pool.query(
          'SELECT id,revision,environment,partner_id,shop_id,state,expires_at FROM connections WHERE environment=$1 AND partner_id=$2 AND shop_id=$3',
          ['production', productionPilotScope.partnerId, productionPilotScope.shopId],
        )
      ).rows;
      const c = rows[0];
      if (
        rows.length !== 1 ||
        !c ||
        c.state !== 'connected' ||
        !Number.isInteger(c.revision) ||
        c.revision < 1 ||
        Date.parse(String(c.expires_at)) <= now()
      )
        fail('AUTH_REQUIRED');
      return c;
    };
    const connected = await connection();
    const metadataService = new ProductionPreparationMetadataService(this.repo);
    const metadataCache = new Map<string, Promise<ProductionPreparationMetadata>>();
    const metadata = (query: ProductionPreparationMetadataQuery) => {
      signal?.throwIfAborted();
      const q = { ...query, includeInventory: false },
        key = canonicalJson(q);
      if (!metadataCache.has(key))
        metadataCache.set(
          key,
          (this.options.metadata ? this.options.metadata(q) : metadataService.get(q, signal)).then((m) => {
            signal?.throwIfAborted();
            if (m.connectionRevision !== connected.revision || !same(m.scope, productionPilotScope))
              fail('CONNECTION_CHANGED');
            return m;
          }),
        );
      return metadataCache.get(key)!;
    };
    const base = await metadata({});
    const history = (
      await this.repo.pool.query(
        `SELECT to_jsonb(o) AS operation,(SELECT to_jsonb(v) FROM production_pilot_verifications v WHERE v.operation_id=o.id) AS verification FROM production_pilot_operations o WHERE o.connection_id=$1 AND o.owner_key=$2 AND o.state='verified' ORDER BY o.created_at DESC LIMIT 100`,
        [
          connected.id,
          `production:${productionPilotScope.partnerId}:${productionPilotScope.shopId}`,
        ],
      )
    ).rows.filter((r) => checkedHistory(r, connected));
    let stockMetadata: ProductionPreparationMetadata | undefined;
    // The metadata reader validates complete write/readback proofs; no guessed default warehouse.
    for (const itemId of [...new Set<string>(history.map((r) => r.operation.item_id))].slice(
      0,
      3,
    )) {
      try {
        const m = await metadata({ referenceItemId: itemId });
        if (m.reference?.writeMappingVerified && m.reference.writeMapping) {
          stockMetadata = m;
          break;
        }
      } catch (error) {
        if (/AUTH_REQUIRED|CONNECTION_CHANGED/.test(String(error))) throw error;
      }
    }
    const stockProof = stockMetadata?.reference?.writeMapping;
    const verifiedLogistics = stockProof
      ? history.find(
          (r) =>
            r.operation.id === stockProof.verifiedOperationId &&
            r.verification.evidence_fingerprint === stockProof.verificationFingerprint,
        )?.operation.source_payload.document.logistics
      : undefined;
    const importCache = new Map<string, ReturnType<Repository['getImport']>>();
    const getImport = (id: string) => {
      if (!importCache.has(id)) importCache.set(id, this.repo.getImport(id));
      return importCache.get(id)!;
    };
    const entries: PreparationAutofillEntry[] = [];
    const snapshots = new Map<string, string>();
    for (const entry of request.entries) {
      signal?.throwIfAborted();
      const result: PreparationAutofillEntry = {
        productKey: entry.productKey,
        sourceRevision: entry.sourceRevision,
        choices: {},
        explanations: [],
        unresolved: [],
        issues: [],
      };
      entries.push(result);
      const add = (field: string, value: unknown, message: string, source: string) => {
        (result.choices as any)[field] = value;
        result.explanations.push({ field, value, message, source });
      };
      const missing = (field: string, message: string) => {
        if (!result.unresolved.some((x) => x.field === field))
          result.unresolved.push({ field, message });
      };
      try {
        const draft = await this.repo.getProduct(entry.productKey);
        if (!draft || draft.revision !== entry.sourceRevision)
          throw Error('SOURCE_REVISION_CHANGED');
        await assertDraftLocalSourcesActive(this.repo.pool, draft);
        snapshots.set(entry.productKey, hash(draft));
        const skus = draft.variants.map((v) => v.sku.value);
        if (
          !skus.length ||
          new Set(skus).size !== skus.length ||
          draft.variants.some((v) => !knownFact(v.sku))
        )
          throw Error('SOURCE_SKU_UNCONFIRMED');
        const sourceRows = await Promise.all(
          draft.variants.map(async (v, index) => {
            const selected = draft.sourceSelection?.variants[index];
            if (!selected) return null;
            const book = await getImport(selected.importId);
            if (!book || book.kind !== 'xlsx' || book.status !== 'ready') return null;
            const rows = (book.body as WorkbookImport)?.rows?.filter(
              (r) => r.key === selected.rowKey && r.sku.value === v.sku.value,
            );
            const row = rows?.length === 1 ? rows[0] : null;
            return row && knownFact(row.sku) && same(selected.optionLabels, v.optionLabels)
              ? row
              : null;
          }),
        );
        const allRows = sourceRows.length === skus.length && sourceRows.every(Boolean);
        const brandNames = allRows
          ? sourceRows.flatMap((row) => (knownFact(row?.brand) ? [row!.brand!.value] : []))
          : [];
        const brandName =
          brandNames.length === skus.length && new Set(brandNames).size === 1
            ? brandNames[0]
            : undefined;
        if (brandName)
          add(
            'brandName',
            brandName,
            'Tên thương hiệu khớp toàn bộ SKU trong bảng giá đã chọn.',
            'sourceSelection.variants → workbook.brand',
          );
        const weights = draft.variants.map((v, index) =>
          knownFact(v.declaredWeightGrams) &&
          knownFact(sourceRows[index]?.declaredWeightGrams) &&
          v.declaredWeightGrams!.value === sourceRows[index]!.declaredWeightGrams!.value
            ? Number(v.declaredWeightGrams!.value)
            : NaN,
        );
        if (allRows && weights.every((v) => Number.isFinite(v) && v > 0))
          add(
            'weightGrams',
            Math.max(...weights),
            'Dùng cân nặng khai báo lớn nhất trong đầy đủ SKU của nguồn.',
            'DORIS: declaredWeightGrams',
          );
        else missing('weightGrams', 'Chưa đủ cân nặng khai báo khớp bảng giá cho mọi SKU.');
        const savedCategory = knownFact(draft.categoryId) ? draft.categoryId!.value : undefined;
        const savedBrand = knownFact(draft.brandId) ? draft.brandId!.value : undefined;
        if (
          (savedCategory && entry.categoryId && savedCategory !== entry.categoryId) ||
          (savedBrand && entry.brandId && savedBrand !== entry.brandId)
        )
          throw Error('CONFIRMED_FACT_CONFLICT');
        let category = entry.categoryId ?? savedCategory;
        const originalFamily = sourceFamily(draft.title.value);
        const extendedRoom =
          originalFamily === null && allRows && corroboratedRoomSource(draft, sourceRows);
        const additionalFamily =
          allRows && (originalFamily === null || originalFamily === 'special')
            ? corroboratedAdditionalFamily(draft, sourceRows)
            : null;
        const family = additionalFamily ?? originalFamily ?? (extendedRoom ? 'room' : null),
          sourceCategory = categoryFromSource(family, base);
        const knowledgeRows =
          attributeMode === 'minimum_required' && (category || sourceCategory)
            ? []
            : (
                await this.repo.pool.query(
                  `SELECT i.evidence_id,o.body,o.scope,o.observed_at FROM seller_knowledge_items i JOIN seller_knowledge_observations o ON o.id=i.evidence_id WHERE i.connection_id=$1 AND i.complete AND i.item_status IN ('NORMAL','UNLIST') AND (i.model_skus && $2::text[] OR i.item_sku=ANY($2::text[])) ORDER BY i.last_seen_at DESC LIMIT 201`,
                  [connected.id, skus],
                )
              ).rows;
        const observations = knowledgeRows.flatMap((r) => {
          try {
            const o = normalizeSellerObservation({
              ...r.body,
              evidenceId: r.evidence_id,
              scope: r.scope,
              observedAt:
                r.observed_at instanceof Date ? r.observed_at.toISOString() : r.observed_at,
            });
            return same(o.scope, productionPilotScope) ? [o] : [];
          } catch {
            return [];
          }
        });
        if (!category) {
          const complete = knowledgeRows.length <= 200;
          const matching = observations.filter(
            (o) =>
              o.skuIdentityComplete &&
              family !== null &&
              sourceFamily(o.title) === family &&
              o.status === 'NORMAL' &&
              now() - Date.parse(o.observedAt) >= 0 &&
              now() - Date.parse(o.observedAt) <= 30 * 86400000 &&
              skus.every((s) => o.modelSkus.includes(s)),
          );
          const categories = [
            ...new Set<string>(matching.map((r) => String(r.categoryId)).filter(supportedId)),
          ];
          const categoryEvidence = complete && categories.length === 1 ? categories[0] : undefined;
          // Exact SKU history may refer to a different use of the same material. Source family wins
          // only when unambiguous; conflicting evidence requires an explicit operator selection.
          if (
            categories.length > 1 ||
            (sourceCategory && categoryEvidence && sourceCategory !== categoryEvidence)
          )
            missing(
              'categoryId',
              'Nguồn và lịch sử có ngành khác nhau; cần chọn ngành cho đúng công dụng.',
            );
          else if (sourceCategory) {
            category = sourceCategory;
            result.explanations.push({
              field: 'categoryId',
              value: category,
              message: additionalFamily
                ? 'Công dụng trong tên và cách dùng khớp dòng SKU nguồn; ngành đề xuất theo công dụng, cần kiểm lại trước khi gửi.'
                : extendedRoom
                  ? 'Tên và cách dùng cùng mô tả xịt phòng; tên mọi SKU đã chọn trong bảng giá xác nhận dạng xịt.'
                  : 'Loại sản phẩm ghi rõ trong tên nguồn khớp một ngành hiện hành.',
              source:
                extendedRoom || additionalFamily
                  ? 'draft.title + draft.description + all selected workbook SKU names + current category tree'
                  : 'draft.title + current category tree',
            });
          } else if (
            categoryEvidence &&
            family !== null &&
            family !== 'special' &&
            matching.every((o) => sourceFamily(o.title) === family)
          ) {
            category = categoryEvidence;
            result.explanations.push({
              field: 'categoryId',
              value: category,
              message:
                'Lịch sử cùng shop, cùng công dụng phủ đủ SKU và chỉ có một ngành; cần kiểm trước khi gửi.',
              source: matching
                .map((r) => `${r.title} (item ${r.itemId}; evidence ${r.evidenceId})`)
                .join('; '),
            });
          }
        }
        if (category && base.categories.some((c) => c.id === category)) {
          add(
            'categoryId',
            category,
            entry.categoryId
              ? 'Giữ ngành đang chọn.'
              : savedCategory
                ? 'Giữ ngành đã xác nhận trong nguồn.'
                : 'Đề xuất ngành cần kiểm trước khi gửi.',
            entry.categoryId
              ? 'operator selection'
              : savedCategory
                ? 'draft.categoryId'
                : 'source/category evidence',
          );
          const m = await metadata({ categoryId: category, ...(brandName ? { brandName } : {}) });
          result.metadata = m;
          const wantedBrand = entry.brandId ?? savedBrand;
          const exactBrands = m.brands?.searchComplete
            ? m.brands.items.filter((b) => brandName && normalize(b.name) === normalize(brandName))
            : [];
          if (wantedBrand) {
            if (
              m.brands?.items.some(
                (b) =>
                  b.id === wantedBrand &&
                  (!brandName || normalize(b.name) === normalize(brandName)),
              )
            )
              add(
                'brandId',
                wantedBrand,
                'Thương hiệu đang chọn có trong ngành hiện hành và khớp nguồn.',
                'current brand metadata',
              );
            else
              missing('brandId', 'Thương hiệu đang chọn chưa khớp danh sách ngành hoặc tên nguồn.');
          } else if (exactBrands.length === 1)
            add(
              'brandId',
              exactBrands[0]!.id,
              'Tên nguồn khớp duy nhất sau khi đọc đầy đủ danh sách thương hiệu của ngành.',
              'current brand metadata',
            );
          const attrs: NonNullable<Choices['attributeList']> = [];
          const sourceLines = draft.description.flatMap((block) =>
            block.type === 'text' ? block.text.split(/\r?\n/).map(normalize) : [],
          );
          const singleBottle =
            sourceLines.some(
              (line) =>
                /\bmoi (lua chon|phan loai) gom (1|mot) chai\b/.test(line) &&
                !/\b(khong|chua)\b/.test(line),
            ) && !/\b(combo|bo doi|bo ba|set)\b/.test(normalize(draft.title.value));
          const ordinaryStorage =
            sourceLines.some((line) =>
              /^(bao quan|cat)( san pham| chai)? (o |tai )?noi kho( rao)? thoang( mat)?\b/.test(
                line,
              ),
            ) &&
            !sourceLines.some((line) =>
              /^(bao quan|cat).*(tu lanh|ngan lanh|ngan da|dong lanh)/.test(line),
            );
          const declaredLiquid = draft.description.some(
            (block) =>
              block.type === 'text' &&
              block.text
                .split(/\r?\n/)
                .some((line) => /^dang (dung dich|long)\b/.test(normalize(line))),
          );
          for (const attr of m.attributes ?? []) {
            const saved = draft.attributes[attr.id];
            if (savedCategory === category && knownFact(saved)) {
              const raw = Array.isArray(saved.value) ? saved.value : [saved.value];
              const values = raw.map((v) =>
                typeof v === 'string' && /^\d+$/.test(v)
                  ? { value_id: Number(v) }
                  : v && typeof v === 'object' && !Array.isArray(v) && 'valueId' in v
                    ? {
                        value_id: Number(v.valueId),
                        ...('originalValueName' in v
                          ? { original_value_name: String(v.originalValueName) }
                          : {}),
                        ...('valueUnit' in v ? { value_unit: String(v.valueUnit) } : {}),
                      }
                    : null,
              );
              if (
                values.length &&
                values.every((v) => v && attr.values.some((a) => a.id === String(v.value_id))) &&
                (!attr.maxValueCount || values.length <= attr.maxValueCount)
              )
                attrs.push({ attribute_id: Number(attr.id), attribute_value_list: values as any });
            }
            // Fast mode retains cheap saved facts, but does not derive optional details.
            if (attributeMode === 'minimum_required' && !attr.mandatory) continue;
            if (
              !attrs.some((a) => a.attribute_id === Number(attr.id)) &&
              ((singleBottle &&
                ['kieu dong goi', 'quantity per pack'].includes(normalize(attr.label))) ||
                (ordinaryStorage && normalize(attr.label) === 'dieu kien bao quan'))
            ) {
              const wanted =
                normalize(attr.label) === 'kieu dong goi'
                  ? 'don'
                  : normalize(attr.label) === 'quantity per pack'
                    ? '1'
                    : 'dieu kien thuong';
              const values = attr.values.filter((value) => normalize(value.label) === wanted);
              if (values.length === 1) {
                attrs.push({
                  attribute_id: Number(attr.id),
                  attribute_value_list: [{ value_id: Number(values[0]!.id) }],
                });
                result.explanations.push({
                  field: `attributes.${attr.id}`,
                  message:
                    wanted === 'dieu kien thuong'
                      ? 'Mô tả nguồn hướng dẫn cất nơi khô thoáng; đề xuất điều kiện thường.'
                      : 'Mô tả nguồn ghi rõ mỗi lựa chọn gồm 1 chai.',
                  source:
                    'draft.description: ' +
                    sourceLines
                      .filter((line) =>
                        wanted === 'dieu kien thuong'
                          ? /^(bao quan|cat)/.test(line)
                          : /moi (lua chon|phan loai) gom/.test(line),
                      )
                      .join('; '),
                });
              }
            }
            if (
              !attrs.some((a) => a.attribute_id === Number(attr.id)) &&
              family === 'floor' &&
              sourceCategory === category &&
              normalize(attr.label) === 'loai chat lam sach' &&
              ['single_dropdown', 'single_combobox'].includes(attr.inputType)
            ) {
              const values = attr.values.filter((v) => normalize(v.label) === 'chat tay rua san');
              if (values.length === 1)
                attrs.push({
                  attribute_id: Number(attr.id),
                  attribute_value_list: [{ value_id: Number(values[0]!.id) }],
                });
            }
            if (
              !attrs.some((a) => a.attribute_id === Number(attr.id)) &&
              declaredLiquid &&
              normalize(attr.label) === 'cong thuc'
            ) {
              const values = attr.values.filter((value) => normalize(value.label) === 'dang long');
              if (values.length === 1) {
                attrs.push({
                  attribute_id: Number(attr.id),
                  attribute_value_list: [{ value_id: Number(values[0]!.id) }],
                });
                result.explanations.push({
                  field: `attributes.${attr.id}`,
                  message:
                    'Nguồn mô tả ghi rõ dạng dung dịch/dạng lỏng; khớp giá trị Dạng Lỏng trong ngành.',
                  source: 'draft.description: explicit form declaration',
                });
              }
            }
            if (
              !attrs.some((a) => a.attribute_id === Number(attr.id)) &&
              /^xit\b/.test(normalize(draft.title.value)) &&
              ['cong thuc', 'mau nuoc hoa'].includes(normalize(attr.label))
            ) {
              const value = attr.values.filter((v) =>
                ['dang xit', 'xit'].includes(normalize(v.label)),
              );
              if (value.length === 1)
                attrs.push({
                  attribute_id: Number(attr.id),
                  attribute_value_list: [{ value_id: Number(value[0]!.id) }],
                });
            }
            if (
              !attrs.some((a) => a.attribute_id === Number(attr.id)) &&
              normalize(attr.label) === 'the tich' &&
              allRows
            ) {
              const amounts = sourceRows.map((row, i) => {
                const text = [row?.name?.value ?? '', ...draft.variants[i]!.optionLabels].join(' ');
                const matches = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*(ml|lít|lit|l)\b/gi)].map(
                  (v) =>
                    Number(v[1]!.replace(',', '.')) * (v[2]!.toLowerCase() === 'ml' ? 1 : 1000),
                );
                return matches.length && new Set(matches).size === 1 ? matches[0] : undefined;
              });
              if (
                amounts.every((v) => v !== undefined && v > 0) &&
                new Set(amounts).size === 1 &&
                attr.inputType === 'single_combobox' &&
                attr.validationType === 3 &&
                attr.units.includes('ml')
              )
                attrs.push({
                  attribute_id: Number(attr.id),
                  attribute_value_list: [
                    { value_id: 0, original_value_name: String(amounts[0]), value_unit: 'ml' },
                  ],
                });
            }
          }
          if (result.choices.brandId !== undefined && attributeMode === 'source_supported') {
            const flatten = (
              tree: NonNullable<ProductionPreparationMetadata['attributes']>,
              dependsOn: Array<{ attributeId: number; valueId: number }> = [],
            ): SellerKnowledgeAttributeMetadata[] =>
              tree.flatMap((a) => {
                if (
                  a.inputTypeCode === null ||
                  a.validationType === null ||
                  a.formatType === null ||
                  a.validationType === 4
                )
                  return [];
                return [
                  {
                    attributeId: Number(a.id),
                    name: a.label,
                    mandatory: a.mandatory,
                    inputType: a.inputTypeCode,
                    inputValidationType: a.validationType,
                    formatType: a.formatType,
                    ...(a.maxValueCount ? { maxValueCount: a.maxValueCount } : {}),
                    units: a.units,
                    values: a.values.map((v) => ({
                      valueId: Number(v.id),
                      name: v.label,
                      ...(v.unit ? { valueUnit: v.unit } : {}),
                    })),
                    ...(dependsOn.length ? { dependsOn } : {}),
                  },
                  ...a.values.flatMap((v) =>
                    flatten(v.children, [
                      ...dependsOn,
                      { attributeId: Number(a.id), valueId: Number(v.id) },
                    ]),
                  ),
                ];
              });
            const sourceFacts = attrs.map((a) => ({
              attributeId: a.attribute_id,
              values: a.attribute_value_list.map((v) => ({
                valueId: v.value_id,
                ...(v.original_value_name ? { originalValueName: v.original_value_name } : {}),
                ...(v.value_unit ? { valueUnit: v.value_unit } : {}),
              })),
              confirmed: true,
              sourceId: `draft:${entry.productKey}:${entry.sourceRevision}`,
              sourceLocator: 'Saved draft and exact selected workbook rows',
            }));
            const currentAttributes = flatten(m.attributes ?? []);
            // Positive value IDs are the category-scoped identity. Localized names differ
            // from immutable English readback labels; normalize only a copy for comparison.
            // Unknown IDs, units and custom value 0 retain their original validation.
            const canonicalObservations = observations.map((observation) => ({
              ...observation,
              attributes: observation.attributes.map((attribute) => ({
                ...attribute,
                values: attribute.values.map((value) => {
                  const allowed =
                    value.valueId > 0
                      ? currentAttributes
                          .find((a) => a.attributeId === attribute.attributeId)
                          ?.values?.find((v) => v.valueId === value.valueId)
                      : undefined;
                  return allowed ? { ...value, originalValueName: allowed.name } : { ...value };
                }),
              })),
            }));
            const knowledge = recommendSellerKnowledge(
              {
                scope: productionPilotScope,
                categoryId: Number(category),
                brandId: Number(result.choices.brandId),
                skus,
                modelCount: skus.length,
                skuIdentityComplete: true,
                sourceFacts,
              },
              canonicalObservations,
              {
                scope: productionPilotScope,
                categoryId: Number(category),
                observedAt: m.observedAt,
                attributes: currentAttributes,
              },
              new Date(now()),
            );
            result.knowledgeIssues = knowledge.issues;
            result.knowledgeSuggestions = knowledge.suggestions.map((s) => {
              const refs = observations.filter((o) => s.evidenceIds.includes(o.evidenceId));
              const safeHistory =
                knowledgeRows.length <= 200 &&
                s.sourceClass === 'exact_sku' &&
                s.confidence === 'reference' &&
                s.values.length > 0 &&
                !s.coverage.partial &&
                [100016, 100036, 100784, 101050, 101306].includes(s.attributeId) &&
                family !== null &&
                family !== 'special' &&
                refs.length > 0 &&
                refs.every((o) => sourceFamily(o.title) === family) &&
                !s.reasons.some((r) => r !== 'HISTORICAL_REFERENCE_ONLY') &&
                !/\b(combo|bo doi|bo ba|set)\b/.test(normalize(draft.title.value));
              const existing = attrs.some((a) => a.attribute_id === s.attributeId);
              if (safeHistory && !existing) {
                attrs.push({
                  attribute_id: s.attributeId,
                  attribute_value_list: s.values.map((v) => ({
                    value_id: v.valueId,
                    ...(v.originalValueName ? { original_value_name: v.originalValueName } : {}),
                    ...(v.valueUnit ? { value_unit: v.valueUnit } : {}),
                  })),
                });
                result.explanations.push({
                  field: `attributes.${s.attributeId}`,
                  message: `Đề xuất từ lịch sử cùng shop, cùng công dụng, phủ đủ SKU: ${s.name}. Đây là tham khảo, chưa phải dữ kiện nguồn đã xác nhận.`,
                  source: refs
                    .map((o) => `${o.title} (item ${o.itemId}; evidence ${o.evidenceId})`)
                    .join('; '),
                });
              }
              return {
                ...s,
                applied: existing || safeHistory,
                references: refs.map((o) => ({
                  itemId: o.itemId,
                  title: o.title,
                  evidenceId: o.evidenceId,
                })),
              };
            });
            if (knowledgeRows.length > 200)
              result.explanations.push({
                field: 'attributeList',
                message:
                  'Nguồn lịch sử vượt giới hạn lượt đọc; chỉ giữ thuộc tính có dữ kiện nguồn, không tự điền lịch sử.',
                source: 'seller_knowledge_items: coverage incomplete',
              });
          }
          for (const attr of m.attributes ?? [])
            if (attr.mandatory && !attrs.some((a) => a.attribute_id === Number(attr.id)))
              missing(`attributes.${attr.id}`, `Cần nguồn xác nhận: ${attr.label}.`);
          if (attrs.length)
            add(
              'attributeList',
              attrs,
              'Thuộc tính từ nguồn và các tham khảo cùng SKU đủ điều kiện; lý do chi tiết ghi theo từng thuộc tính.',
              'source facts + current schema + scoped shop history',
            );
        } else if (category)
          missing('categoryId', 'Ngành đã chọn không có trong cây ngành hiện hành.');
        else result.metadata = base;
        for (const field of ['condition', 'preOrder', 'dimensionCm'] as const)
          if ((field === 'dimensionCm' ? entry.dimensionCm ?? request.shared?.dimensionCm : request.shared?.[field]) !== undefined)
            add(
              field,
              field === 'dimensionCm' ? entry.dimensionCm ?? request.shared?.dimensionCm : request.shared?.[field],
              'Lựa chọn chung do người dùng cung cấp cho lượt chuẩn bị này.',
              'current bulk user choice',
            );
        const limits = result.metadata?.itemLimits;
        const pre = result.choices.preOrder;
        if (
          pre?.is_pre_order &&
          (!pre.days_to_ship ||
            (limits?.daysToShip.min != null && pre.days_to_ship < limits.daysToShip.min) ||
            (limits?.daysToShip.max != null && pre.days_to_ship > limits.daysToShip.max))
        ) {
          delete result.choices.preOrder;
          missing('preOrder', 'Số ngày chuẩn bị hàng chưa có hoặc ngoài giới hạn ngành.');
        }
        if (stockProof && stockMetadata?.reference) {
          add(
            'stockLocation',
            {
              referenceItemId: stockMetadata.reference.itemId,
              expectedLocationBySku: Object.fromEntries(
                skus.map((s) => [s, stockProof.expectedLocationId]),
              ),
              writeLocationBySku: Object.fromEntries(
                skus.map((s) => [s, stockProof.writeLocationId]),
              ),
            },
            'Kho đã được đối chiếu lại với bằng chứng ghi/đọc thành công của shop; ánh xạ riêng đúng từng SKU hiện tại.',
            `operation:${stockProof.verifiedOperationId} / ${stockProof.verificationFingerprint}`,
          );
        }
        const channels = result.metadata?.channels ?? base.channels;
        const saved = Object.entries(draft.logistics)
          .filter(([, f]) => knownFact(f) && typeof f.value === 'boolean')
          .map(([channelId, f]) => ({ channelId, enabled: f.value as boolean }));
        const allEligible = request.logisticsMode === 'all_eligible';
        const prior: { channelId: string; enabled: boolean }[] | undefined = saved.length ? saved : verifiedLogistics;
        if (allEligible || Array.isArray(prior)) {
          const { selected, requiredMissing } = eligibleProductChannels(channels,
            result.choices.weightGrams, result.choices.dimensionCm,
            allEligible ? undefined : new Set((prior ?? []).filter(p => p.enabled).map(p => p.channelId)));
          const changedSaved = !allEligible && saved.some(p => p.enabled && !selected.some(c => c.id === p.channelId));
          if (selected.length && !requiredMissing && !changedSaved)
            add('logistics', selected.map(c => ({channelId:c.id,enabled:true})),
              allEligible ? 'Bật tất cả nhóm vận chuyển đủ điều kiện đăng sản phẩm theo API hiện tại của shop; kiểm riêng cân nặng và kích thước từng listing.'
                : 'Kênh có trong nguồn/lịch sử và còn đủ điều kiện đăng theo API hiện tại của shop.',
              'Shopee get_channel_list: enabled=true, mask_channel_id=0; shop:' + base.shop.id);
          if (requiredMissing) missing('logistics', 'Chưa có đủ nhóm vận chuyển bắt buộc phù hợp kiện hàng; cần kiểm tra cấu hình.');
          if (allEligible) for (const channel of channels.filter(c => c.parentId === '0' && !selected.some(s => s.id === c.id))) {
            result.explanations.push({field:'logistics',
              message: channel.name + ': ' + (productChannelIssue(channel,result.choices.weightGrams,result.choices.dimensionCm) ?? 'Chưa đáp ứng quy tắc liên kết với kênh khác.'),
              source:'Shopee get_channel_list / ' + channel.id});
          }
        }
        const labels: Record<string, string> = {
          categoryId: 'ngành phù hợp công dụng',
          brandId: 'thương hiệu trong ngành',
          brandName: 'tên thương hiệu nguồn',
          logistics: 'kênh giao phù hợp kiện hàng',
          dimensionCm: 'kích thước kiện',
          condition: 'tình trạng hàng',
          preOrder: 'thời gian chuẩn bị hàng',
          stockLocation: 'bằng chứng kho ghi tồn',
        };
        for (const [field, label] of Object.entries(labels))
          if ((result.choices as any)[field] === undefined)
            missing(field, `Cần xác nhận ${label}.`);
      } catch (error) {
        signal?.throwIfAborted();
        if (/PRODUCTION_PREPARATION_(AUTH_REQUIRED|CONNECTION_CHANGED)/.test(String(error)))
          throw error;
        const code = error instanceof Error ? error.message : 'SOURCE_UNAVAILABLE';
        result.choices = {};
        result.explanations = [];
        result.issues.push({
          code: /^[A-Z_]+$/.test(code) ? code : 'SOURCE_UNAVAILABLE',
          message:
            'Chưa thể đề xuất cho nguồn này; cần kiểm phiên bản, trạng thái lưu trữ và dữ kiện nguồn.',
        });
      }
    }
    for (const result of entries)
      if (snapshots.has(result.productKey) && !result.issues.length) {
        try {
          const current = await this.repo.getProduct(result.productKey);
          if (!current || hash(current) !== snapshots.get(result.productKey))
            throw Error('SOURCE_REVISION_CHANGED');
          await assertDraftLocalSourcesActive(this.repo.pool, current);
        } catch (error) {
          result.choices = {};
          result.explanations = [];
          result.metadata = undefined;
          result.issues.push({
            code: error instanceof Error ? error.message : 'SOURCE_REVISION_CHANGED',
            message: 'Nguồn đã thay đổi trong lúc đọc đề xuất; tải lại trước khi chọn.',
          });
        }
      }
    const current = await connection();
    if (current.id !== connected.id || current.revision !== connected.revision)
      fail('CONNECTION_CHANGED');
    const observedAt = new Date(now()).toISOString();
    const result: ProductionPreparationAutofillResult = {
      attributeMode,
      scope: productionPilotScope,
      connectionRevision: connected.revision,
      observedAt,
      fingerprint: hash({ request, entries, connectionRevision: connected.revision }),
      entries,
    };
    if (this.options.auditRoot !== false) {
      const root = this.options.auditRoot ?? resolve('.local/production-preparation-autofill');
      await mkdir(root, { recursive: true });
      const path = resolve(root, hash({ request, result }) + '.json');
      try {
        await writeFile(path, JSON.stringify({ request, result }, null, 2), {
          encoding: 'utf8',
          flag: 'wx',
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') fail('AUTOFILL_AUDIT_FAILED');
      }
      result.auditPath = path;
    }
    return result;
  }
}
