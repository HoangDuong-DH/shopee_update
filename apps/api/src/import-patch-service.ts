import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalJson,
  compileDescription,
  readPatchWorkbook,
  type PatchSelection,
  type PatchPreview,
  type PatchReceipt,
  type PatchWorkbook,
  type PatchOperation,
  type PatchTarget,
  type Issue,
  type ListingDraft,
  type ContentBlock,
  type SourceRef,
  type WordImport,
  type WorkOrderView,
} from '@shopee/domain';
import {
  Repository,
  BlobStore,
  ImportPatchRepository,
  type ImportRecord,
} from '@shopee/persistence';
import { WorkbenchService } from './workbench-service.js';
const uuid = z.string().uuid(),
  indices = z
    .array(z.number().int().min(0))
    .min(1)
    .max(5000)
    .refine((values) => values.every((value, index) => index === 0 || value > values[index - 1]));
const ids = z
  .array(uuid)
  .min(1)
  .max(100)
  .refine((values) => new Set(values).size === values.length);
export const patchSelectionSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => !!value.trim()),
    workOrders: z
      .array(z.object({ id: uuid, revision: z.number().int().positive() }).strict())
      .min(1)
      .max(500),
    fileRefs: z
      .array(
        z
          .object({
            importId: uuid,
            relativePath: z
              .string()
              .min(1)
              .max(1024)
              .refine(
                (value) =>
                  !/[\x00-\x1f\\:*?"<>|]/.test(value) &&
                  value.split('/').every((part) => part && part !== '.' && part !== '..'),
              )
              .optional(),
          })
          .strict(),
      )
      .max(5000),
    workbooks: z
      .array(
        z
          .object({
            importId: uuid,
            sheet: z.string().min(1).max(255),
            blockKey: z.string().min(1).max(200),
            workOrderIds: z.array(uuid).min(1).max(500),
            fields: z
              .array(z.enum(['price', 'stock']))
              .min(1)
              .max(2),
          })
          .strict(),
      )
      .max(100),
    contents: z
      .array(
        z
          .object({
            workOrderId: uuid,
            word: z
              .object({
                importId: uuid,
                titleParagraphs: indices.optional(),
                descriptionParagraphs: indices.optional(),
                separator: z.enum(['\n', '\n\n']),
              })
              .strict()
              .optional(),
            coverImportId: uuid.optional(),
            gallery: z
              .object({ mode: z.literal('replace'), importIds: ids })
              .strict()
              .optional(),
            descriptionImages: z
              .object({ mode: z.literal('replace'), importIds: ids })
              .strict()
              .optional(),
            descriptionLayout: z
              .enum(['preserve_source', 'images_after_first_paragraph'])
              .optional(),
            variantImages: z
              .array(z.object({ sku: z.string().min(1).max(200), importId: uuid }).strict())
              .max(2000)
              .optional(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const saveSchema = z
  .object({
    id: uuid,
    selection: patchSelectionSchema,
    previewFingerprint: fingerprint,
    selectedOperationIds: z.array(fingerprint).max(20000),
  })
  .strict();
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function issue(
  code: string,
  field: string,
  message: string,
  sources: SourceRef[] = [],
  severity: 'block' | 'warn' = 'block',
): Issue {
  return { code, field, message, sources, severity };
}
function semanticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticValue);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if ('sha256' in object) return { sha256: object.sha256 };
    return Object.fromEntries(
      Object.entries(object).map(([key, val]) => [key, semanticValue(val)]),
    );
  }
  return value;
}
function opSemantic(op: PatchOperation, target: PatchTarget) {
  return {
    target: {
      workOrderId: target.workOrderId,
      workOrderRevision: target.workOrderRevision,
      productKey: target.productKey,
      sourceRevision: target.sourceRevision,
      environment: target.environment,
      partnerId: target.partnerId,
      shopId: target.shopId,
      itemId: target.itemId,
    },
    field: op.field,
    sku: op.sku ?? null,
    action: op.action,
    after: semanticValue(op.after),
  };
}
export class ImportPatchService {
  readonly store: ImportPatchRepository;
  readonly workbench: WorkbenchService;
  constructor(
    readonly repo: Repository,
    readonly blobs: BlobStore,
  ) {
    this.store = new ImportPatchRepository(repo.pool);
    this.workbench = new WorkbenchService(repo);
  }
  async context() {
    const [workbench, imports] = await Promise.all([
      this.workbench.list(),
      this.repo.listImports(),
    ]);
    return {
      workOrders: workbench.orders,
      imports,
      execution: { writesEnabled: false as const, comparisonBasis: 'saved_source' as const },
    };
  }
  private async imported(id: string, kind?: ImportRecord['kind']) {
    uuid.parse(id);
    const record = await this.repo.getImport(id);
    if (!record) throw new Error('PATCH_SOURCE_NOT_FOUND');
    if (kind && record.kind !== kind) throw new Error('PATCH_SOURCE_KIND');
    if (record.kind !== 'xlsx' && record.status !== 'ready')
      throw new Error('PATCH_SOURCE_NOT_READY');
    try {
      const bytes = await this.blobs.read(record.sha256);
      if (bytes.length !== record.bytes) throw new Error();
    } catch {
      throw new Error('PATCH_SOURCE_INTEGRITY');
    }
    return record;
  }
  async workbook(id: string): Promise<PatchWorkbook> {
    const record = await this.imported(id, 'xlsx');
    return readPatchWorkbook(
      await this.blobs.read(record.sha256),
      record.filename,
      record.createdAt,
    );
  }
  async preview(raw: unknown): Promise<PatchPreview> {
    const selection: PatchSelection = patchSelectionSchema.parse(raw);
    const manifestIds = new Set(selection.fileRefs.map((file) => file.importId));
    const paths = new Set<string>();
    for (const file of selection.fileRefs) {
      const key = file.relativePath ?? 'import:' + file.importId;
      if (paths.has(key)) throw new Error('PATCH_MANIFEST_INVALID');
      paths.add(key);
    }
    if (new Set(selection.workOrders.map((item) => item.id)).size !== selection.workOrders.length)
      throw new Error('PATCH_DUPLICATE_TARGET');
    const targets: PatchTarget[] = [],
      orders = new Map<string, WorkOrderView>(),
      operations: PatchOperation[] = [],
      issues: Issue[] = [],
      executionBlockers: PatchPreview['executionBlockers'] = [];
    for (const ref of selection.workOrders) {
      const order = await this.workbench.get(ref.id);
      if (order.revision !== ref.revision) throw new Error('PATCH_TARGET_CHANGED');
      if (
        order.config.operation !== 'update' ||
        !order.config.itemId ||
        !order.config.connectionId ||
        !order.shop
      )
        throw new Error('PATCH_TARGET_REQUIRED');
      if (order.source.revision !== order.latestSourceRevision)
        throw new Error('PATCH_SOURCE_CHANGED');
      const shop = order.shop;
      targets.push({
        workOrderId: order.id,
        workOrderRevision: order.revision,
        productKey: order.config.productKey,
        sourceRevision: order.config.sourceRevision,
        connectionId: shop.id,
        connectionRevision: shop.scope.connectionRevision,
        environment: shop.scope.environment,
        partnerId: shop.scope.partnerId,
        shopId: shop.scope.shopId,
        shopName: shop.name,
        itemId: order.config.itemId,
        title: order.source.title.value,
      });
      orders.set(order.id, order);
      for (const item of order.issues.filter(
        (item) =>
          item.kind === 'connection' ||
          item.kind === 'conflict' ||
          item.code === 'PRODUCTION_READ_ONLY',
      ))
        executionBlockers.push({ workOrderId: order.id, code: item.code, message: item.message });
      executionBlockers.push({
        workOrderId: order.id,
        code: 'PATCH_EXECUTOR_NOT_RELEASED',
        message: 'Chỉ lưu bộ cập nhật tại ứng dụng; chưa gửi hoặc đọc đối chiếu Shopee.',
      });
    }
    const targetMap = new Map(targets.map((target) => [target.workOrderId, target]));
    const sourceCache = new Map<string, ImportRecord>(),
      used = new Set<string>();
    const source = async (id: string, kind?: ImportRecord['kind']) => {
      const record = sourceCache.get(id) ?? (await this.imported(id, kind));
      if (kind && record.kind !== kind) throw new Error('PATCH_SOURCE_KIND');
      if (!manifestIds.has(id)) throw new Error('PATCH_SOURCE_OUTSIDE_MANIFEST');
      sourceCache.set(id, record);
      used.add(id);
      return record;
    };
    const ref = (record: ImportRecord, locator: string): SourceRef & { importId: string } => ({
      kind: 'product_file',
      fileSha256: record.sha256,
      filename: record.filename,
      locator,
      observedAt: record.createdAt,
      importId: record.id,
    });
    const image = async (id: string) => {
      const record = await source(id, 'image');
      return { importId: id, sha256: record.sha256 };
    };
    const priorImage = (draft: ListingDraft, id: string | undefined) =>
      id
        ? {
            importId: draft.assets.find((asset) => asset.key === id)?.key ?? null,
            sha256: draft.assets.find((asset) => asset.key === id)?.sha256 ?? null,
          }
        : null;
    const add = (
      orderId: string,
      field: PatchOperation['field'],
      before: unknown,
      after: unknown,
      sources: PatchOperation['sources'],
      opIssues: Issue[] = [],
      sku?: string,
    ) => {
      const op: PatchOperation = {
        id: '',
        workOrderId: orderId,
        ...(sku ? { sku } : {}),
        field,
        action: ['gallery', 'description'].includes(field) ? 'replace' : 'set',
        before,
        after,
        sources,
        state: opIssues.some((item) => item.severity === 'block')
          ? 'blocked'
          : canonicalJson(semanticValue(before)) === canonicalJson(semanticValue(after))
            ? 'unchanged'
            : 'changed',
        issues: opIssues,
      };
      op.id = hash(opSemantic(op, targetMap.get(orderId)!));
      const same = operations.find((old) => old.id === op.id);
      if (same) {
        same.sources.push(...sources);
        same.issues.push(...opIssues);
        if (op.state === 'blocked') same.state = 'blocked';
        return;
      }
      operations.push(op);
    };
    const requireOrder = (id: string) => {
      const order = orders.get(id);
      if (!order) throw new Error('PATCH_TARGET_OUTSIDE_SELECTION');
      return order;
    };
    for (const selected of selection.workbooks) {
      if (
        new Set(selected.workOrderIds).size !== selected.workOrderIds.length ||
        new Set(selected.fields).size !== selected.fields.length
      )
        throw new Error('PATCH_DUPLICATE_TARGET');
      selected.workOrderIds.forEach(requireOrder);
      const record = await source(selected.importId, 'xlsx'),
        book = await this.workbook(record.id),
        block = book.blocks.find(
          (item) => item.key === selected.blockKey && item.sheet === selected.sheet,
        );
      if (!block) throw new Error('PATCH_WORKBOOK_SELECTION');
      issues.push(
        ...book.issues.filter((item) =>
          item.sources.some((origin) => origin.locator.startsWith(selected.sheet)),
        ),
        ...block.issues,
      );
      for (const field of selected.fields)
        if (!block.fields.includes(field))
          issues.push(
            issue(
              'PATCH_COLUMN_UNAVAILABLE',
              field,
              'Cột đã chọn không có hoặc còn mơ hồ trong khối nguồn.',
              [ref(record, `${selected.sheet}!${block.headerRow}`)],
            ),
          );
      for (const row of book.rows.filter((row) => row.blockKey === block.key)) {
        issues.push(...row.issues);
        if (row.values.promotionTarget)
          issues.push(
            issue(
              'PATCH_PROMOTION_SEPARATE',
              'promotionTarget',
              'GIÁ BÁN là mục tiêu khuyến mại; chưa tạo thay đổi giá gốc hoặc chương trình khuyến mại.',
              row.values.promotionTarget.sources,
              'warn',
            ),
          );
        if (!selected.fields.some((field) => row.values[field]) && !row.issues.length) continue;
        const matches = selected.workOrderIds
          .map(requireOrder)
          .filter((order) =>
            order.source.variants.some((variant) => variant.sku.value === row.sku),
          );
        if (!matches.length) {
          issues.push(
            issue(
              'PATCH_SKU_UNMATCHED',
              'sku',
              `SKU ${row.sku} chưa khớp bộ nguồn trong những công việc đã chọn.`,
              [row.source],
            ),
          );
          continue;
        }
        const shopCounts = new Map<string, number>();
        for (const order of matches)
          shopCounts.set(
            order.config.connectionId!,
            1 + (shopCounts.get(order.config.connectionId!) ?? 0),
          );
        for (const order of matches) {
          const variants = order.source.variants.filter((variant) => variant.sku.value === row.sku);
          if (shopCounts.get(order.config.connectionId!)! > 1 || variants.length !== 1) {
            issues.push(
              issue(
                'PATCH_TARGET_AMBIGUOUS',
                'sku',
                `SKU ${row.sku} khớp nhiều đích trong một shop; cần chọn rõ công việc.`,
                [row.source],
              ),
            );
            continue;
          }
          for (const field of selected.fields) {
            const fact = row.values[field];
            if (!fact) continue;
            const relevant = row.issues.filter((item) => ['sku', field].includes(item.field));
            add(
              order.id,
              field,
              field === 'price'
                ? variants[0].originalPrice.value
                : (order.config.stocks[row.sku] ?? null),
              fact.value,
              fact.sources.map((origin) => ({ ...origin, importId: record.id })),
              relevant,
              row.sku,
            );
          }
        }
      }
    }
    for (const selected of selection.contents) {
      const order = requireOrder(selected.workOrderId),
        draft = order.source;
      if (selected.coverImportId) {
        const after = await image(selected.coverImportId);
        add(order.id, 'cover', priorImage(draft, draft.coverKey), after, [
          ref(sourceCache.get(selected.coverImportId)!, 'cover'),
        ]);
      }
      if (selected.gallery) {
        const after = await Promise.all(selected.gallery.importIds.map(image));
        add(
          order.id,
          'gallery',
          draft.galleryKeys.map((key) => priorImage(draft, key)),
          after,
          selected.gallery.importIds.map((id, index) =>
            ref(sourceCache.get(id)!, `gallery[${index}]`),
          ),
        );
      }
      for (const chosen of selected.variantImages ?? []) {
        const after = await image(chosen.importId),
          variants = draft.variants.filter((variant) => variant.sku.value === chosen.sku);
        if (variants.length !== 1) {
          issues.push(
            issue(
              'PATCH_VARIANT_UNMATCHED',
              'variantImage',
              `Ảnh phân loại chưa có một SKU đích duy nhất: ${chosen.sku}`,
              [ref(sourceCache.get(chosen.importId)!, 'variantImage')],
            ),
          );
          continue;
        }
        add(
          order.id,
          'variantImage',
          priorImage(draft, variants[0].imageKey),
          after,
          [ref(sourceCache.get(chosen.importId)!, `variantImage:${chosen.sku}`)],
          [],
          chosen.sku,
        );
      }
      let paragraphs: string[] | undefined, wordRecord: ImportRecord | undefined;
      const wordSources: PatchOperation['sources'] = [];
      if (selected.word) {
        wordRecord = await source(selected.word.importId, 'docx');
        const body = wordRecord.body as WordImport;
        if (
          !Array.isArray(body?.paragraphs) ||
          body.paragraphs.some((value) => typeof value !== 'string')
        )
          throw new Error('PATCH_WORD_UNAVAILABLE');
        const read = (indices: number[]) =>
          indices.map((index) => {
            if (index >= body.paragraphs.length) throw new Error('PATCH_WORD_SELECTION');
            return body.paragraphs[index];
          });
        if (selected.word.titleParagraphs) {
          const title = read(selected.word.titleParagraphs).join(selected.word.separator);
          add(
            order.id,
            'title',
            draft.title.value,
            title,
            selected.word.titleParagraphs.map((index) => ref(wordRecord!, `paragraph[${index}]`)),
            title.trim()
              ? []
              : [
                  issue(
                    'PATCH_EMPTY_TEXT',
                    'title',
                    'Đoạn tiêu đề đã chọn không có chữ. Không suy thành lệnh xóa.',
                  ),
                ],
          );
        }
        if (selected.word.descriptionParagraphs) {
          paragraphs = read(selected.word.descriptionParagraphs);
          wordSources.push(
            ...selected.word.descriptionParagraphs.map((index) =>
              ref(wordRecord!, `paragraph[${index}]`),
            ),
          );
        }
      }
      if (paragraphs || selected.descriptionImages) {
        const previousImages = draft.description
          .filter(
            (block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image',
          )
          .map((block) => block.assetKey);
        const imageIds = selected.descriptionImages?.importIds ?? previousImages;
        const descIssues: Issue[] = [];
        if (selected.descriptionImages)
          for (const [index, id] of imageIds.entries()) {
            await image(id);
            wordSources.push(ref(sourceCache.get(id)!, `descriptionImage[${index}]`));
          }
        let after: ContentBlock[] = [];
        if (paragraphs) {
          if (!paragraphs.join('').trim())
            descIssues.push(
              issue(
                'PATCH_EMPTY_TEXT',
                'description',
                'Đoạn mô tả đã chọn không có chữ. Không suy thành lệnh xóa.',
                wordSources,
              ),
            );
          if (imageIds.length) {
            if (selected.descriptionLayout !== 'images_after_first_paragraph')
              descIssues.push(
                issue(
                  'PATCH_DESCRIPTION_LAYOUT_REQUIRED',
                  'description',
                  'Mô tả có ảnh. Chọn rõ vị trí đặt ảnh trong Word mới trước khi lưu thay đổi.',
                  wordSources,
                ),
              );
            else
              after = compileDescription(
                paragraphs[0],
                paragraphs.slice(1).join(selected.word!.separator),
                imageIds,
              );
          } else after = [{ type: 'text', text: paragraphs.join(selected.word!.separator) }];
        } else {
          const saved = draft.sourceSelection;
          const canonical =
            saved &&
            canonicalJson(
              compileDescription(saved.headline, saved.body, saved.descriptionImageIds),
            ) === canonicalJson(draft.description);
          if (!canonical)
            descIssues.push(
              issue(
                'PATCH_DESCRIPTION_LAYOUT_REQUIRED',
                'description',
                'Chưa có bố cục mô tả được xác nhận để thay bộ ảnh riêng. Cần chọn Word và vị trí ảnh.',
                wordSources,
              ),
            );
          else after = compileDescription(saved.headline, saved.body, imageIds);
        }
        add(order.id, 'description', draft.description, after, wordSources, descIssues);
        issues.push(...descIssues);
      }
    }
    for (const op of operations) {
      const conflicts = operations.filter(
        (other) =>
          other !== op &&
          other.workOrderId === op.workOrderId &&
          other.field === op.field &&
          other.sku === op.sku,
      );
      if (conflicts.length) {
        const conflict = issue(
          'PATCH_OPERATION_CONFLICT',
          op.field,
          'Nhiều nguồn đưa giá trị khác nhau cho cùng một đích và trường.',
          op.sources,
        );
        op.issues.push(conflict);
        op.state = 'blocked';
        issues.push(conflict);
      }
    }
    for (const file of selection.fileRefs) {
      if (!used.has(file.importId)) {
        const record = await this.imported(file.importId);
        issues.push(
          issue(
            'PATCH_UNUSED_FILE',
            'file',
            'Tệp đã nhập chưa được gắn vào thay đổi nào; được giữ trong đợt.',
            [ref(record, file.relativePath ?? record.filename)],
            'warn',
          ),
        );
      }
    }
    const preview: PatchPreview = {
      selection,
      targets,
      operations,
      issues,
      executionBlockers,
      comparisonBasis: 'saved_source',
      remoteRead: false,
      fingerprint: '',
      semanticFingerprint: '',
    };
    preview.semanticFingerprint = hash(
      operations
        .map((op) => opSemantic(op, targetMap.get(op.workOrderId)!))
        .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    );
    preview.fingerprint = hash({
      ...preview,
      fingerprint: undefined,
      semanticFingerprint: undefined,
    });
    return preview;
  }
  async save(raw: unknown): Promise<{ receipt: PatchReceipt; reused: boolean }> {
    const input = saveSchema.parse(raw),
      requestFingerprint = hash(input),
      prior = await this.store.replay(input.id, requestFingerprint);
    if (prior) return { receipt: prior, reused: true };
    const preview = await this.preview(input.selection);
    if (preview.fingerprint !== input.previewFingerprint) throw new Error('PATCH_PREVIEW_CHANGED');
    if (
      !input.selectedOperationIds.length ||
      new Set(input.selectedOperationIds).size !== input.selectedOperationIds.length
    )
      throw new Error('PATCH_SELECTION_BLOCKED');
    const selected = input.selectedOperationIds.map((id) =>
      preview.operations.find((op) => op.id === id),
    );
    if (selected.some((op) => !op || op.state !== 'changed'))
      throw new Error('PATCH_SELECTION_BLOCKED');
    const semanticFingerprint = hash(
      (selected as PatchOperation[])
        .map((op) =>
          opSemantic(
            op,
            preview.targets.find((target) => target.workOrderId === op.workOrderId)!,
          ),
        )
        .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    );
    const receipt: PatchReceipt = {
      id: input.id,
      revision: 1,
      name: input.selection.name,
      state: 'prepared',
      createdAt: new Date().toISOString(),
      preview,
      selectedOperationIds: [...input.selectedOperationIds],
      fingerprint: hash({
        preview: preview.fingerprint,
        selectedOperationIds: [...input.selectedOperationIds].sort(),
      }),
    };
    return this.store.save(input.id, requestFingerprint, semanticFingerprint, receipt);
  }
  async get(id: string): Promise<PatchReceipt> {
    uuid.parse(id);
    const receipt = await this.store.get(id);
    if (!receipt) throw new Error('PATCH_NOT_FOUND');
    return receipt;
  }
  async list() {
    return this.store.list();
  }
}
