import ExcelJS from 'exceljs';
import { ZodError } from 'zod';
import { createHash } from 'node:crypto';
import {
  InputLibraryRepository,
  listShopConnections,
  type BlobStore,
  type Repository,
} from '@shopee/persistence';
import {
  canonicalJson,
  compileDescription,
  headerKey,
  type AssetRef,
  type CatalogRow,
  type ListingDraft,
  type PreparedEntry,
  type PreparedMedia,
  type SourceRef,
  type WorkbookImport,
  type WordImport,
} from '@shopee/domain';
import { checkOfficeArchive } from '../../../packages/domain/src/source/archive.js';
import { validatePreparedEntry } from './prepared-execution.js';

type CellRow = { row: number; fields: Record<string, unknown>; source: SourceRef };
export type PreparedSourceIssue = { code: string; message: string; field: string };
export type PreparedSourceRow = {
  folderKey: string;
  shopName: string;
  categoryId: string;
  title: string;
  skuCount: number;
  issues: PreparedSourceIssue[];
  entry?: PreparedEntry;
  draft?: ListingDraft;
};
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function cellValue(cell: ExcelJS.Cell): unknown {
  const value = cell.value;
  if (value && typeof value === 'object') {
    // A cached formula result has no provenance about its freshness. Require a value export.
    if ('formula' in value || 'sharedFormula' in value)
      throw new Error('PREPARED_FORMULA_REQUIRES_VALUES');
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('text' in value) return value.text;
    throw new Error('PREPARED_CELL_INVALID');
  }
  return value ?? null;
}
function sheetRows(sheet: ExcelJS.Worksheet, source: SourceRef): CellRow[] {
  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, col) => {
    const h = headerKey(String(cellValue(cell) ?? ''));
    if (!h) return;
    if (headers.has(h)) throw new Error('PREPARED_DUPLICATE_HEADER');
    headers.set(h, col);
  });
  const rows: CellRow[] = [];
  for (let n = 2; n <= sheet.rowCount; n++) {
    const fields = Object.fromEntries(
      [...headers].map(([h, col]) => [h, cellValue(sheet.getCell(n, col))]),
    );
    if (Object.values(fields).every((v) => v === null || v === '')) continue;
    rows.push({ row: n, fields, source: { ...source, locator: `${sheet.name}!${n}` } });
  }
  return rows;
}
export async function readPreparedDispatch(
  bytes: Uint8Array,
  filename: string,
  observedAt = new Date().toISOString(),
) {
  checkOfficeArchive(bytes);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
  const source: SourceRef = {
    kind: 'product_file',
    filename,
    fileSha256: sha(bytes),
    locator: filename,
    observedAt,
  };
  const coordination = book.getWorksheet('Điều phối listing');
  if (!coordination) throw new Error('PREPARED_DISPATCH_SHEET_REQUIRED');
  return {
    source,
    rows: sheetRows(coordination, source),
    sheets: new Map(
      book.worksheets.filter((s) => s !== coordination).map((s) => [s.name, sheetRows(s, source)]),
    ),
  };
}
function required(fields: Record<string, unknown>, name: string): string {
  const value = fields[headerKey(name)];
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '')
    throw new Error('PREPARED_MISSING:' + name);
  return String(value);
}
function numeric(fields: Record<string, unknown>, name: string, min = 0): number {
  const raw = required(fields, name);
  if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error('PREPARED_NUMBER:' + name);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error('PREPARED_NUMBER:' + name);
  return n;
}
function identity(fields: Record<string, unknown>, name: string, zero = false) {
  const s = required(fields, name);
  if (!/^\d+$/.test(s) || (!zero && BigInt(s) === 0n)) throw new Error('PREPARED_ID:' + name);
  return s;
}
function filename(value: string) {
  if (
    !value ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.split('/').some((p) => !p || p === '.' || p === '..') ||
    /[\x00-\x1f:]/.test(value)
  )
    throw new Error('PREPARED_FILE_PATH');
  return value;
}
function filenames(fields: Record<string, unknown>, name: string) {
  const v = fields[headerKey(name)];
  if (v === null || v === undefined || v === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(v));
  } catch {
    throw new Error('PREPARED_IMAGE_LIST:' + name);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((v) => typeof v !== 'string') ||
    new Set(parsed).size !== parsed.length
  )
    throw new Error('PREPARED_IMAGE_LIST:' + name);
  return parsed.map(filename);
}
function sourceIssue(error: unknown): PreparedSourceIssue {
  if (error instanceof ZodError)
    return {
      code: 'PREPARED_SOURCE_ENVELOPE',
      field: error.issues.map((issue) => issue.path.join('.')).join(', '),
      message: 'Dữ liệu ngoài cấu trúc được hỗ trợ; cần đối chiếu trường nguồn trước khi chạy.',
    };
  const code = error instanceof Error ? error.message : 'PREPARED_SOURCE_INVALID';
  const field = code.split(':').slice(1).join(':') || 'nguồn';
  const names: Record<string, string> = {
    PREPARED_MISSING: 'Thiếu thông tin',
    PREPARED_NUMBER: 'Số liệu chưa hợp lệ',
    PREPARED_ID: 'Cần mã rõ ràng',
    PREPARED_FILE_MISSING: 'Không tìm thấy tệp trong đúng thư mục',
    PREPARED_PRICE_AMBIGUOUS: 'SKU có nhiều dòng giá trong bộ giá đã chọn',
    PREPARED_PRICE_MISSING: 'Thiếu SKU trong bộ giá',
    PREPARED_STOCK_MISSING: 'Chưa có tồn bán',
    PREPARED_WORD_HEADERS: 'Word thiếu hoặc trùng nhãn nội dung',
    PREPARED_SHOP_AMBIGUOUS: 'Shop chưa kết nối hoặc trùng phạm vi',
    PREPARED_SCOPE_READ_ONLY: 'Shop thật đang chỉ đọc',
  };
  return {
    code: code.split(':')[0]!,
    field,
    message: (names[code.split(':')[0]!] ?? 'Cần đối chiếu thông tin nguồn') + ': ' + field,
  };
}

/** Reads only persisted input references and checks blob identity before building a sourced document. */
export async function buildPreparedSources(
  repo: Repository,
  blobs: BlobStore,
  input: {
    inputBatchId: string;
    inputBatchRevision: number;
    workbookImportId: string;
    folderKeys?: string[];
  },
) {
  const batch = await new InputLibraryRepository(repo.pool).get(input.inputBatchId);
  if (!batch || batch.revision !== input.inputBatchRevision)
    throw new Error('PREPARED_INPUT_REVISION_CHANGED');
  const workbook = await repo.getImport(input.workbookImportId);
  if (workbook?.kind !== 'xlsx' || workbook.status !== 'ready')
    throw new Error('PREPARED_WORKBOOK_NOT_READY');
  const dispatch = await readPreparedDispatch(
    await blobs.read(workbook.sha256),
    workbook.filename,
    (workbook.body as WorkbookImport).source.observedAt,
  );
  const catalog = (workbook.body as WorkbookImport).rows;
  const shops = await listShopConnections(repo.pool);
  const files = new Map(batch.state.files.map((f) => [f.relativePath, f]));
  const imports = new Map(batch.imports.map((i) => [i.id, i]));
  const groups = Object.keys(batch.state.productKeys);
  const selection = input.folderKeys;
  if (
    selection !== undefined &&
    (!selection.length ||
      new Set(selection).size !== selection.length ||
      selection.some((key) => !groups.includes(key)))
  )
    throw new Error('PREPARED_FOLDER_SELECTION_INVALID');
  const rows: PreparedSourceRow[] = [];
  const touched = new Set<string>();
  const checked = new Set<string>();
  for (const row of dispatch.rows) {
    const f = row.fields;
    let folderKey = String(f['THU MUC'] ?? ''),
      shopName = String(f['SHOP ID'] ?? ''),
      categoryId = String(f['MA NGANH'] ?? '');
    const out: PreparedSourceRow = {
      folderKey,
      shopName,
      categoryId,
      title: '',
      skuCount: 0,
      issues: [],
    };
    rows.push(out);
    try {
      const folder = required(f, 'THƯ MỤC');
      const matches = groups.filter((g) => g === folder || g.split('/').at(-1) === folder);
      if (matches.length !== 1) throw new Error('PREPARED_FOLDER_AMBIGUOUS:' + folder);
      folderKey = matches[0]!;
      out.folderKey = folderKey;
      if (touched.has(folderKey)) throw new Error('PREPARED_FOLDER_DUPLICATE:' + folder);
      touched.add(folderKey);
      const shopId = identity(f, 'SHOP ID');
      const candidates = shops.filter((s) => s.scope.shopId === shopId);
      if (candidates.length !== 1 || candidates[0]!.state !== 'connected')
        throw new Error('PREPARED_SHOP_AMBIGUOUS:' + shopId);
      const shop = candidates[0]!;
      out.shopName = shop.name;
      if (shop.scope.environment !== 'sandbox')
        throw new Error('PREPARED_SCOPE_READ_ONLY:' + shopId);
      async function getFile(name: string, kind: 'docx' | 'image') {
        const path = folderKey + '/' + filename(name),
          file = files.get(path),
          record = file?.importId ? imports.get(file.importId) : undefined;
        if (!file || !record || record.status !== 'ready' || record.kind !== kind)
          throw new Error('PREPARED_FILE_MISSING:' + name);
        if (file.sha256 !== record.sha256 || file.size !== record.bytes)
          throw new Error('PREPARED_FILE_CHANGED:' + name);
        if (!checked.has(record.id)) {
          await blobs.read(record.sha256);
          checked.add(record.id);
        }
        return record;
      }
      const selectedAssets = new Map<string, AssetRef>();
      async function media(name: string): Promise<PreparedMedia> {
        const r = await getFile(name, 'image'),
          a = r.body as AssetRef;
        if (
          a.sha256 !== r.sha256 ||
          !Number.isSafeInteger(a.width) ||
          !Number.isSafeInteger(a.height) ||
          a.width <= 0 ||
          a.height <= 0
        )
          throw new Error('PREPARED_IMAGE_INVALID:' + name);
        selectedAssets.set(r.id, { ...a, key: r.id });
        return { importId: r.id, sha256: r.sha256, width: a.width, height: a.height, mime: a.mime };
      }
      const wordRecord = await getFile(required(f, 'WORD'), 'docx'),
        word = wordRecord.body as WordImport;
      const titleHeads = word.paragraphs
          .map((p, i) => (headerKey(p) === 'TIEU DE' ? i : -1))
          .filter((i) => i >= 0),
        bodyHeads = word.paragraphs
          .map((p, i) => (headerKey(p) === 'BAI MO TA DANG BAN' ? i : -1))
          .filter((i) => i >= 0);
      if (
        titleHeads.length !== 1 ||
        bodyHeads.length !== 1 ||
        bodyHeads[0] !== titleHeads[0]! + 2 ||
        !word.paragraphs[titleHeads[0]! + 1]
      )
        throw new Error('PREPARED_WORD_HEADERS');
      const title = word.paragraphs[titleHeads[0]! + 1]!,
        parts = word.paragraphs.slice(bodyHeads[0]! + 1);
      if (!parts.length || !parts.some((p) => p.trim())) throw new Error('PREPARED_WORD_EMPTY');
      out.title = title;
      const cover = await media(required(f, 'ẢNH BÌA')),
        gallery = await Promise.all(filenames(f, 'ẢNH GALLERY').map(media)),
        descriptionImages = await Promise.all(filenames(f, 'ẢNH MÔ TẢ').map(media));
      if (cover.width !== cover.height) throw new Error('PREPARED_COVER_RATIO');
      if (!gallery.length || gallery.some((a) => a.width * 4 !== a.height * 3))
        throw new Error('PREPARED_GALLERY_RATIO');
      const tierNames = [f['TEN TANG 1'], f['TEN TANG 2']]
        .filter((v) => v !== null && v !== undefined && v !== '')
        .map(String);
      if (!f['TEN TANG 1'] && f['TEN TANG 2']) throw new Error('PREPARED_TIER_GAP');
      const priceSheet = required(f, 'BẢNG GIÁ'),
        rawRows = dispatch.sheets.get(priceSheet);
      if (!rawRows) throw new Error('PREPARED_PRICE_SHEET:' + priceSheet);
      const selectedRows = rawRows.filter(
        (r) => r.fields['THU MUC'] === folder || r.fields['THU MUC'] === folderKey,
      );
      if (!selectedRows.length) throw new Error('PREPARED_PRICE_MISSING:' + folder);
      const optionOrder: string[][] = tierNames.map(() => []),
        usedSku = new Set<string>(),
        usedOptions = new Set<string>();
      const variantSources: CatalogRow[] = [];
      const models = [];
      for (const r of selectedRows) {
        const sku = required(r.fields, 'SKU');
        if (usedSku.has(sku)) throw new Error('PREPARED_PRICE_AMBIGUOUS:' + sku);
        usedSku.add(sku);
        const matches = catalog.filter(
          (c) => c.sheet === priceSheet && c.row === r.row && c.sku.value === sku,
        );
        if (matches.length !== 1) throw new Error('PREPARED_PRICE_AMBIGUOUS:' + sku);
        const c = matches[0]!;
        if (
          c.issues.some((i) => i.severity === 'block') ||
          !c.originalPrice?.confirmed ||
          !/^\d+$/.test(c.originalPrice.value) ||
          BigInt(c.originalPrice.value) <= 0n
        )
          throw new Error('PREPARED_PRICE_INVALID:' + sku);
        variantSources.push(c);
        const stock = numeric(r.fields, 'TỒN BÁN');
        if (!Number.isSafeInteger(stock)) throw new Error('PREPARED_NUMBER:TỒN BÁN');
        const labels = tierNames.map((_, i) => required(r.fields, 'PHÂN LOẠI ' + (i + 1)));
        if (labels.some((s) => !s.trim()) || usedOptions.has(JSON.stringify(labels)))
          throw new Error('PREPARED_OPTIONS_AMBIGUOUS:' + sku);
        usedOptions.add(JSON.stringify(labels));
        const tierIndex = labels.map((label, i) => {
          if (!optionOrder[i]!.includes(label)) optionOrder[i]!.push(label);
          return optionOrder[i]!.indexOf(label);
        });
        const imageName = r.fields['ANH PHAN LOAI'];
        models.push({
          sku,
          optionLabels: labels,
          tierIndex,
          originalPrice: c.originalPrice.value,
          stock,
          ...(imageName ? { image: await media(String(imageName)) } : {}),
        });
      }
      if (!tierNames.length && models.length !== 1) throw new Error('PREPARED_ZERO_TIER_MODELS');
      const categoryId = identity(f, 'MÃ NGÀNH'),
        brandId = identity(f, 'MÃ THƯƠNG HIỆU', true),
        attributeId = identity(f, 'MÃ THUỘC TÍNH'),
        valueId = identity(f, 'MÃ GIÁ TRỊ');
      const description = compileDescription(
        parts[0]!,
        parts.slice(1).join('\n'),
        descriptionImages.map((a) => a.importId),
      );
      const sourceRefs = [
        row.source,
        word.source,
        ...variantSources.flatMap((r) => [...r.sku.sources, ...r.originalPrice!.sources]),
        ...selectedAssets.values(),
      ].map((s: any) => s.source ?? s) as SourceRef[];
      const entry: PreparedEntry = {
        folderKey,
        connectionId: shop.id,
        scope: shop.scope,
        sourceFingerprint: '',
        sourceRefs,
        document: {
          sourceKey: batch.state.productKeys[folderKey]!,
          title,
          description: description.map((b) =>
            b.type === 'text'
              ? b
              : {
                  type: 'image' as const,
                  image: descriptionImages.find((i) => i.importId === b.assetKey)!,
                },
          ),
          cover,
          gallery,
          tierNames,
          models,
          categoryId,
          brandId,
          attributes: { [attributeId]: [valueId] },
          logistics: [{ channelId: identity(f, 'KÊNH VẬN CHUYỂN'), enabled: true }],
          weightGrams: numeric(f, 'CÂN NẶNG G', 0.001),
          dimensionCm: {
            length: numeric(f, 'DÀI CM', 0.001),
            width: numeric(f, 'RỘNG CM', 0.001),
            height: numeric(f, 'CAO CM', 0.001),
          },
          publication: 'unlisted',
        },
      };
      entry.sourceFingerprint = sha(
        canonicalJson({
          document: entry.document,
          workbookHash: workbook.sha256,
          wordHash: wordRecord.sha256,
          sourceRow: row.row,
        }),
      );
      const fact = <T>(value: T) => ({ value, confirmed: true, sources: [row.source] });
      out.entry = validatePreparedEntry(entry);
      out.categoryId = categoryId;
      out.skuCount = models.length;
      out.draft = {
        productKey: entry.document.sourceKey,
        revision: 1,
        title: { value: title, confirmed: true, sources: [word.source] },
        description,
        coverKey: cover.importId,
        galleryKeys: gallery.map((a) => a.importId),
        tierNames,
        variants: models.map((m, i) => ({
          key: m.sku,
          sku: variantSources[i]!.sku,
          optionLabels: m.optionLabels,
          originalPrice: variantSources[i]!.originalPrice!,
          promotionTarget: variantSources[i]!.promotionTarget,
          declaredWeightGrams: fact(String(entry.document.weightGrams)),
          ...(m.image ? { imageKey: m.image.importId } : {}),
        })),
        assets: [...selectedAssets.values()],
        categoryId: fact(categoryId),
        brandId: fact(brandId),
        attributes: { [attributeId]: fact([valueId]) },
        logistics: {
          channels: fact(entry.document.logistics),
          weightGrams: fact(entry.document.weightGrams),
          dimensionCm: fact(entry.document.dimensionCm),
        },
        publication: fact('unlisted' as const),
        issues: [],
      };
    } catch (error) {
      delete out.entry;
      delete out.draft;
      out.issues.push(sourceIssue(error));
    }
  }
  for (const folderKey of groups)
    if (!touched.has(folderKey))
      rows.push({
        folderKey,
        shopName: '',
        categoryId: '',
        title: '',
        skuCount: 0,
        issues: [
          {
            code: 'PREPARED_DISPATCH_MISSING',
            field: 'Điều phối listing',
            message: 'Thư mục chưa có dòng điều phối shop/ngành trong Excel.',
          },
        ],
      });
  // Duplicate routing invalidates every occurrence, not only the second row.
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.folderKey, (count.get(r.folderKey) ?? 0) + 1);
  for (const r of rows)
    if (count.get(r.folderKey)! > 1) {
      delete r.entry;
      delete r.draft;
      if (!r.issues.some((i) => i.code === 'PREPARED_FOLDER_DUPLICATE'))
        r.issues.push({
          code: 'PREPARED_FOLDER_DUPLICATE',
          field: r.folderKey,
          message: 'Thư mục có nhiều dòng điều phối; cần chọn một phạm vi rõ ràng.',
        });
    }
  return {
    rows: selection ? rows.filter((row) => selection.includes(row.folderKey)) : rows,
    batch,
    workbook,
    sourceDigest: sha(
      canonicalJson({
        batchId: batch.id,
        revision: batch.revision,
        files: batch.state.files,
        workbook: workbook.sha256,
        folderKeys: selection ?? groups,
      }),
    ),
  };
}
