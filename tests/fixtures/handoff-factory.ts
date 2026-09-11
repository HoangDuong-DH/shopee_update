import { createHash, randomUUID } from 'node:crypto';
import type {
  AssetRef,
  CatalogRow,
  HandoffDocument,
  InputBatchState,
  SourceRef,
  WorkbookImport,
  WordImport,
} from '../../packages/domain/src/index.js';
import type { ImportRecord } from '../../packages/persistence/src/index.js';

/** Fully synthetic records: no private workbook, shop, credentials or product images. */
export function createHandoffFixture(tiers: 0 | 1 | 2, label = 'Bộ mẫu') {
  const productKey = 'fixture-' + randomUUID(),
    batchId = randomUUID(),
    groupKey = label;
  const observedAt = '2026-09-11T00:00:00Z';
  const record = (filename: string, kind: ImportRecord['kind']): ImportRecord => ({
    id: randomUUID(),
    filename,
    kind,
    bytes: 12,
    sha256: createHash('sha256')
      .update(productKey + filename)
      .digest('hex'),
    status: 'ready',
    createdAt: observedAt,
    message: '',
    body: null,
  });
  const sourceRef = (file: ImportRecord): SourceRef => ({
    fileSha256: file.sha256,
    filename: file.filename,
    locator: 'fixture',
    observedAt,
    kind: 'product_file',
  });
  const cover = record('bìa.png', 'image'),
    gallery = record('nội dung.png', 'image'),
    variantImage = record('phân loại.png', 'image');
  for (const image of [cover, gallery, variantImage])
    image.body = {
      key: image.id,
      sha256: image.sha256,
      bytes: image.bytes,
      mime: 'image/png',
      width: image === cover ? 1000 : 900,
      height: image === cover ? 1000 : 1200,
      source: sourceRef(image),
    } satisfies AssetRef;
  const word = record('nội dung.docx', 'docx');
  word.body = {
    source: sourceRef(word),
    paragraphs: [
      ' Tên listing  đã chuẩn bị ',
      'Câu mở đầu',
      'Dòng một\n\n  Dòng hai  ',
      '',
      'Dòng cuối',
    ],
  } satisfies WordImport;
  const price = record('Bảng giá chung.xlsx', 'xlsx');
  const fact = (value: string) => ({ value, confirmed: true, sources: [sourceRef(price)] });
  const skus = tiers === 0 ? ['001'] : tiers === 1 ? ['A-01', 'A-02'] : ['B-01', 'B-02', 'B-03'];
  const optionLabels =
    tiers === 0
      ? [[]]
      : tiers === 1
        ? [[' Trắng '], ['Đen']]
        : [
            [' Trắng ', '100 cái'],
            ['Đen', ' 300 cái '],
            ['Đen', '500 cái'],
          ];
  const rows: CatalogRow[] = skus.map((sku, index) => ({
    key: 'row-' + index,
    sheet: 'Bảng chung',
    priceProfile: 'Shop mẫu',
    row: index + 3,
    headerRow: 2,
    sku: fact(sku),
    name: fact('Tên hàng nguồn ' + sku),
    originalPrice: fact(String(120000 + index * 1000)),
    promotionTarget: fact(String(60000 + index * 500)),
    issues: [],
  }));
  price.body = {
    source: sourceRef(price),
    rows,
    issues: [],
    sheets: [
      { name: 'Bảng chung', rowCount: rows.length + 2, importedRows: rows.length, headerRows: [2] },
    ],
  } satisfies WorkbookImport;
  const records = [cover, gallery, variantImage, word, price];
  const document: HandoffDocument = {
    format: 'shopee-listing-handoff',
    version: 1,
    product: { productKey, sourceRevision: 0 },
    scope: { kind: 'input_batch', batchId, batchRevision: 1, groupKey },
    sources: records.map((value) => ({
      importId: value.id,
      kind: value.kind,
      sha256: value.sha256,
      filename: value.filename,
    })),
    content: {
      origin: { kind: 'user_selection', sourceImportIds: [word.id] },
      title: ' Tên listing  đã chuẩn bị ',
      headline: 'Câu mở đầu',
      body: 'Dòng một\n\n  Dòng hai  \n\nDòng cuối',
    },
    media: { coverId: cover.id, galleryIds: [gallery.id], descriptionImageIds: [gallery.id] },
    tierNames: tiers === 0 ? [] : tiers === 1 ? [' Màu sắc '] : [' Màu sắc ', 'Quy cách'],
    variants: rows.map((row, index) => ({
      price: {
        importId: price.id,
        rowKey: row.key,
        sheet: row.sheet,
        priceProfile: row.priceProfile!,
        sku: row.sku.value,
        originalPrice: row.originalPrice!.value,
        promotionTarget: row.promotionTarget!.value,
      },
      optionLabels: optionLabels[index],
      ...(index === 0 ? { imageId: variantImage.id } : {}),
    })),
    confirmed: { content: true, imageRoles: true, membership: true },
  };
  const batchState: InputBatchState = {
    version: 1,
    name: label,
    mode: 'single_listing',
    files: records
      .filter((value) => value.kind !== 'xlsx')
      .map((value) => ({
        relativePath: groupKey + '/' + value.filename,
        name: value.filename,
        size: value.bytes,
        importId: value.id,
        sha256: value.sha256,
      })),
    priceSelection: { importId: price.id, sheet: 'Bảng chung', priceProfile: 'Shop mẫu' },
    visual: {
      [groupKey]: {
        coverPath: groupKey + '/' + cover.filename,
        galleryPaths: [groupKey + '/' + gallery.filename],
        descriptionPaths: [groupKey + '/' + gallery.filename],
      },
    },
    wordPaths: { [groupKey]: groupKey + '/' + word.filename },
    wordRule: null,
    productKeys: { [groupKey]: productKey },
  };
  return {
    document,
    records,
    batchId,
    batchState,
    productKey,
    cover,
    gallery,
    variantImage,
    word,
    price,
  };
}
