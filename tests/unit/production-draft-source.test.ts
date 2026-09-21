import { createHash, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import {
  compileDescription,
  readKini,
  type AssetRef,
  type Fact,
  type ListingDraft,
  type SourceRef,
} from '@shopee/domain';
import type { ImportRecord } from '@shopee/persistence';
import { buildProductionDraftSource } from '../../apps/api/src/production-draft-source.js';
import { assembleProduct, projectProductPriceIssues } from '../../apps/api/src/product-service.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const decision: SourceRef = {
  kind: 'user_decision',
  fileSha256: 'operator-decision',
  locator: 'Work order configuration',
  observedAt: '2026-09-15T12:00:00.000Z',
};
const fact = <T>(value: T): Fact<T> => ({ value, confirmed: true, sources: [decision] });
async function fixture(
  options: {
    rawSku?: string;
    brand?: string;
    priceProfiles?: boolean;
    sameScopeDuplicate?: boolean;
  } = {},
) {
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet('Prices');
  if (options.priceProfiles) {
    sheet.addRow([
      'SKU',
      'TÊN SẢN PHẨM',
      'CÂN NẶNG KHAI BÁO (G)',
      'SHOP THƯỜNG',
      null,
      'SHOP MALL',
    ]);
    sheet.addRow([null, null, null, 'GIÁ GỐC', 'GIÁ BÁN', 'GIÁ GỐC', 'GIÁ BÁN']);
    for (const column of ['A', 'B', 'C']) sheet.mergeCells(`${column}1:${column}2`);
    sheet.mergeCells('D1:E1');
    sheet.mergeCells('F1:G1');
    sheet.addRow(['A-100', 'Prepared A 100ml', 130.9, 100000, 80000, 120000, 90000]);
    sheet.addRow(['A-300', 'Prepared A 300ml', 322.3, 200000, 160000, 230000, 180000]);
    if (options.sameScopeDuplicate)
      sheet.addRow(['A-100', 'Another A 100ml row', 130.9, 100000, 80000, 125000, 90000]);
  } else {
    sheet.addRow([
      'SKU',
      'TÊN SẢN PHẨM',
      'GIÁ GỐC',
      'GIÁ BÁN',
      'CÂN NẶNG KHAI BÁO (G)',
      'THƯƠNG HIỆU',
    ]);
    sheet.addRow([
      options.rawSku ?? 'A-100',
      'Prepared A 100ml',
      120000,
      90000,
      130.9,
      options.brand,
    ]);
    sheet.addRow(['A-300', 'Prepared A 300ml', 230000, 180000, 322.3, options.brand]);
  }
  const priceBytes = Buffer.from(await book.xlsx.writeBuffer()),
    priceId = randomUUID();
  const parsed = await readKini(priceBytes, 'prices.xlsx');
  const records = new Map<string, ImportRecord>(),
    bytes = new Map<string, Uint8Array>();
  const priceRecord: ImportRecord = {
    id: priceId,
    sha256: digest(priceBytes),
    filename: 'prices.xlsx',
    kind: 'xlsx',
    bytes: priceBytes.length,
    status: 'ready',
    message: '',
    createdAt: decision.observedAt,
    body: parsed,
  };
  records.set(priceId, priceRecord);
  bytes.set(priceRecord.sha256, priceBytes);
  const assets: AssetRef[] = [];
  for (const [index, size] of [
    [0, [100, 100]],
    [1, [90, 120]],
    [2, [100, 100]],
  ] as const) {
    const data = await sharp({
      create: {
        width: size[0],
        height: size[1],
        channels: 3,
        background: { r: index * 50, g: 100, b: 150 },
      },
    })
      .png()
      .toBuffer();
    const id = randomUUID(),
      sha = digest(data),
      source = {
        ...decision,
        kind: 'product_file' as const,
        fileSha256: sha,
        filename: index + '.png',
      };
    const asset: AssetRef = {
      key: id,
      sha256: sha,
      bytes: data.length,
      mime: 'image/png',
      width: size[0],
      height: size[1],
      source,
    };
    assets.push(asset);
    bytes.set(sha, data);
    records.set(id, {
      id,
      sha256: sha,
      filename: index + '.png',
      kind: 'image',
      bytes: data.length,
      status: 'ready',
      message: '',
      createdAt: decision.observedAt,
      body: asset,
    });
  }
  // Use actual parser rows. The source preserves the parser's explicit SKU spelling.
  const rows = options.priceProfiles
    ? parsed.rows.filter((row) => row.priceProfile === 'SHOP MALL').slice(0, 2)
    : parsed.rows;
  const selection = {
    title: '  Prepared title  ',
    headline: 'Heading\n',
    body: 'Original body\n\nKeep paragraphs',
    coverId: assets[0]!.key,
    galleryIds: [assets[1]!.key],
    descriptionImageIds: [],
    tierNames: [' Scent ', 'Size'],
    variants: rows.map((row) => ({
      importId: priceId,
      rowKey: row.key,
      optionLabels: ['Original scent ', row.sku.value.includes('100') ? '100 ml' : '300 ml'],
      imageId: assets[2]!.key,
    })),
  };
  const draft: ListingDraft = {
    productKey: 'prepared-product',
    revision: 4,
    sourceSelection: selection,
    title: fact(selection.title),
    description: compileDescription(selection.headline, selection.body, []),
    coverKey: assets[0]!.key,
    galleryKeys: [assets[1]!.key],
    tierNames: selection.tierNames,
    variants: rows.map((row, index) => ({
      key: row.key,
      sku: row.sku,
      originalPrice: row.originalPrice!,
      promotionTarget: row.promotionTarget,
      declaredWeightGrams: row.declaredWeightGrams,
      optionLabels: selection.variants[index]!.optionLabels,
      imageKey: assets[2]!.key,
    })),
    assets,
    attributes: {},
    logistics: {},
    issues: options.priceProfiles ? structuredClone(rows.flatMap((row) => row.issues)) : [],
  };
  const input = {
    productKey: draft.productKey,
    sourceRevision: 4,
    priceSelection: {
      importId: priceId,
      sheet: 'Prices',
      priceProfile: options.priceProfiles ? 'SHOP MALL' : null,
    },
    stocks: Object.fromEntries(rows.map((row, index) => [row.sku.value, index ? 7 : 0])),
    choices: {
      categoryId: '10',
      brandId: '20',
      brandName: 'Source brand',
      attributeList: [],
      logistics: [{ channelId: '50', enabled: true }],
      weightGrams: 322.3,
      dimensionCm: { length: 12, width: 12, height: 28 },
      condition: 'NEW' as const,
      preOrder: { is_pre_order: false },
      stockLocation: {
        referenceItemId: '1234',
        expectedLocationBySku: Object.fromEntries(rows.map((row) => [row.sku.value, 'VNZ'])),
        writeLocationBySku: Object.fromEntries(rows.map((row) => [row.sku.value, null])),
      },
    },
  };
  const repo = {
    getProduct: async (key: string, revision?: number) =>
      key === draft.productKey && revision === draft.revision ? structuredClone(draft) : null,
    getImport: async (id: string) => records.get(id) ?? null,
  };
  const blobs = {
    read: async (sha: string) => {
      const data = bytes.get(sha);
      if (!data) throw Error('MISSING_BLOB');
      return Buffer.from(data);
    },
  };
  return { input, draft, records, bytes, repo, blobs, priceRecord, parsed };
}
it('resolves only the selected profile duplicate warning in new drafts and historical preview projections', async () => {
  const f = await fixture({ priceProfiles: true });
  const raw = structuredClone(f.parsed),
    historical = structuredClone(f.draft);
  expect(raw.rows.every((row) => row.issues.some((i) => i.code === 'DUPLICATE_SKU'))).toBe(true);
  const assembled = await assembleProduct(f.repo as any, {
    ...f.draft.sourceSelection!,
    expectedRevision: 0,
    productKey: 'new-profile-draft',
  });
  expect(assembled.issues.filter((i) => i.code === 'DUPLICATE_SKU')).toEqual([]);
  expect(assembled.variants.map((v) => v.originalPrice.value)).toEqual(['120000', '230000']);
  const preview = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(preview.kind).toBe('ready');
  expect(preview.issues.filter((i) => i.code === 'DUPLICATE_SKU')).toEqual([]);
  if (preview.kind === 'ready') expect(preview.sourceSnapshot.draft).toEqual(historical);
  expect(f.parsed).toEqual(raw);
  expect(f.draft).toEqual(historical);
});
it('keeps unresolved duplicate warnings when the selected sheet/profile still contains two rows for that SKU', async () => {
  const f = await fixture({ priceProfiles: true, sameScopeDuplicate: true });
  const assembled = await assembleProduct(f.repo as any, {
    ...f.draft.sourceSelection!,
    expectedRevision: 0,
  });
  expect(assembled.issues.some((i) => i.code === 'DUPLICATE_SKU')).toBe(true);
  const preview = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(preview.issues.some((i) => i.code === 'DUPLICATE_SKU')).toBe(true);
});
it('projects historical GET warnings from exact saved facts without changing raw drafts or imports', async () => {
  const f = await fixture({ priceProfiles: true });
  const raw = structuredClone(f.parsed),
    historical = structuredClone(f.draft);
  const projected = await projectProductPriceIssues(f.repo, [f.draft]);
  expect(projected[0]!.issues.filter((i) => i.code === 'DUPLICATE_SKU')).toEqual([]);
  expect({ ...projected[0], issues: historical.issues }).toEqual(historical);
  expect(f.parsed).toEqual(raw);
  expect(f.draft).toEqual(historical);
});
it.each([
  'missing-import',
  'missing-selection',
  'wrong-fact',
  'same-scope',
  'ambiguous-key',
] as const)('keeps historical GET warnings when resolution fails: %s', async (change) => {
  const f = await fixture({ priceProfiles: true, sameScopeDuplicate: change === 'same-scope' });
  if (change === 'missing-import') f.records.delete(f.input.priceSelection.importId);
  if (change === 'missing-selection') delete f.draft.sourceSelection;
  if (change === 'wrong-fact') f.draft.variants[0]!.originalPrice = fact('1');
  if (change === 'ambiguous-key')
    f.parsed.rows.push(
      structuredClone(f.parsed.rows.find((row) => row.key === f.draft.variants[0]!.key)!),
    );
  const projected = await projectProductPriceIssues(f.repo, [f.draft]);
  expect(projected[0]!.issues.some((i) => i.code === 'DUPLICATE_SKU')).toBe(true);
});
it.each(['zero-price', 'unconfirmed-price', 'row-block', 'ambiguous-key'] as const)(
  'does not suppress warnings in a new draft with %s',
  async (change) => {
    const f = await fixture({ priceProfiles: true });
    const row = f.parsed.rows.find((row) => row.key === f.draft.variants[0]!.key)!;
    if (change === 'zero-price') row.originalPrice!.value = '0';
    if (change === 'unconfirmed-price') row.originalPrice!.confirmed = false;
    if (change === 'row-block')
      row.issues.push({
        code: 'SOURCE_ROW_INVALID',
        severity: 'block',
        field: 'source',
        message: 'Keep this issue',
        sources: row.sku.sources,
      });
    if (change === 'ambiguous-key') f.parsed.rows.push(structuredClone(row));
    const assembled = await assembleProduct(f.repo as any, {
      ...f.draft.sourceSelection!,
      expectedRevision: 0,
    });
    expect(assembled.issues.some((i) => i.code === 'DUPLICATE_SKU')).toBe(true);
    if (change === 'row-block')
      expect(assembled.issues.some((i) => i.code === 'SOURCE_ROW_INVALID')).toBe(true);
  },
);
it('preserves other warnings and unrelated duplicate evidence while resolving the selected profile', async () => {
  const f = await fixture({ priceProfiles: true });
  const unrelated = {
    ...f.draft.issues[0]!,
    sources: [{ ...decision, locator: 'Different unresolved source' }],
  };
  const other = { ...unrelated, code: 'HIDDEN_PRICE_COLUMNS', field: 'price' };
  f.draft.issues.push(unrelated, other);
  const projected = await projectProductPriceIssues(f.repo, [f.draft]);
  expect(projected[0]!.issues).toEqual([unrelated, other]);
  const preview = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(preview.kind).toBe('ready');
  expect(preview.issues).toEqual([unrelated, other]);
});
it.each(['scope', 'price', 'rowKey', 'unconfirmed'] as const)(
  'does not resolve historical price warnings for a %s mismatch',
  async (change) => {
    const f = await fixture({ priceProfiles: true });
    if (change === 'scope') f.input.priceSelection.priceProfile = 'SHOP THƯỜNG';
    if (change === 'price') f.draft.variants[0]!.originalPrice.value = '1';
    if (change === 'rowKey') f.draft.sourceSelection!.variants[0]!.rowKey = 'missing-row';
    if (change === 'unconfirmed') f.draft.variants[0]!.sku.confirmed = false;
    const preview = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
    expect(preview.kind).toBe('blocked');
    expect(preview.issues.some((i) => i.code === 'DUPLICATE_SKU')).toBe(true);
  },
);
it('does not create a new link when the saved source points at an existing listing', async () => {
  const f = await fixture();
  (f.draft as any).sourceListingId = fact('29926930476');
  (f.draft.sourceSelection as any).sourceListingId = '29926930476';
  const result = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(result.kind).toBe('blocked');
  expect(result.issues.some((i) => i.code === 'EXISTING_LISTING_REQUIRES_UPDATE')).toBe(true);
  const original = structuredClone(f.draft);
  const declared = await buildProductionDraftSource(
    f.repo,
    f.blobs,
    {
      ...f.input,
      existingListingAuthorization: {
        reason: 'distinct_prepared_listing_test',
        authorizationReference: 'Copied old trial authorization text',
      },
    },
    decision,
  );
  expect(declared.kind).toBe('blocked');
  expect(declared.issues.some((i) => i.code === 'EXISTING_LISTING_REQUIRES_UPDATE')).toBe(true);
  expect(f.draft).toEqual(original);
});
it('does not reinterpret malformed or inconsistent source IDs as new listings even with a test exception', async () => {
  for (const value of ['not-an-id', '9007199254740992']) {
    const f = await fixture();
    (f.draft as any).sourceListingId = fact(value);
    (f.draft.sourceSelection as any).sourceListingId = value;
    const result = await buildProductionDraftSource(
      f.repo,
      f.blobs,
      {
        ...f.input,
        existingListingAuthorization: {
          reason: 'distinct_prepared_listing_test',
          authorizationReference: 'Scoped trial',
        },
      },
      decision,
    );
    expect(result.kind).toBe('blocked');
    expect(result.issues.some((i) => i.code === 'SOURCE_LISTING_ID_INVALID')).toBe(true);
  }
});
it('accepts server-owned portable source provenance without treating it as product data', async () => {
  const f = await fixture();
  const baseline = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  f.draft.folderSource = { productKey: f.draft.productKey, fingerprint: 'a'.repeat(64) };
  const before = structuredClone(f.draft);
  const result = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready' || baseline.kind !== 'ready') return;
  expect(result.document).toEqual(baseline.document);
  expect(f.draft).toEqual(before);
});
it('blocks the pending SKU marker even when a manual source workbook supplies a confirmed positive price', async () => {
  const f = await fixture({ rawSku: 'CHƯA CÓ SKU' });
  f.draft.variants[0]!.optionLabels = ['Original scent ', '100 ml'];
  f.draft.sourceSelection!.variants[0]!.optionLabels = ['Original scent ', '100 ml'];
  expect(f.draft.variants[0]!.sku.value).toBe('CHƯA CÓ SKU');
  expect(f.draft.variants[0]!.sku.confirmed).toBe(true);
  expect(f.draft.variants[0]!.originalPrice.value).toBe('120000');
  const before = structuredClone(f.draft);
  const result = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(result.kind).toBe('blocked');
  expect(result.issues.some((issue) => issue.code === 'MISSING_VARIANT_SKU')).toBe(true);
  expect(f.draft).toEqual(before);
});
it('adds saved gallery images to a text-only description while preserving variants, zero stock and source weights', async () => {
  const f = await fixture(),
    before = structuredClone(f.draft);
  const result = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') return;
  expect(result.document.title).toBe('  Prepared title  ');
  expect(result.document.description.map((block) => block.type)).toEqual(['text', 'image', 'text']);
  expect(result.document.description[0]).toEqual({ type: 'text', text: 'Heading\n\n' });
  expect(result.document.description[1]).toMatchObject({
    type: 'image',
    image: { importId: before.galleryKeys[0] },
  });
  expect(result.document.description[2]).toEqual({
    type: 'text',
    text: '\n\nOriginal body\n\nKeep paragraphs',
  });
  expect(result.document.tierNames).toEqual([' Scent ', 'Size']);
  expect(
    result.document.models.map((m) => [
      m.optionLabels,
      m.tierIndex,
      m.originalPrice,
      m.stock,
      m.weightGrams,
    ]),
  ).toEqual([
    [['Original scent ', '100 ml'], [0, 0], '120000', 0, 130.9],
    [['Original scent ', '300 ml'], [0, 1], '230000', 7, 322.3],
  ]);
  expect(result.document.models[0]!.image?.importId).toBe(before.variants[0]!.imageKey);
  expect(result.assets).toHaveLength(3);
  expect(
    result.priceProof.map((p) => [p.skuCell, p.priceCell, p.originalPrice, p.priceProfile]),
  ).toEqual([
    ['A2', 'C2', '120000', null],
    ['A3', 'C3', '230000', null],
  ]);
  expect(result.sourceSnapshot.input.priceSelection).toEqual(f.input.priceSelection);
  expect(f.draft).toEqual(before);
});
it.each(['videoKeys', 'sizeChartKey', 'identifiers', 'compliance', 'fulfillment'])(
  'blocks unsupported %s instead of silently dropping it',
  async (field) => {
    const f = await fixture();
    (f.draft as any)[field] =
      field === 'videoKeys'
        ? ['video-source']
        : field === 'sizeChartKey'
          ? 'size-chart-source'
          : { sourceField: fact('original') };
    const result = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
    expect(result.kind).toBe('blocked');
    expect(result.issues.some((i) => i.field === field)).toBe(true);
  },
);
it.each(['sku', 'originalPrice', 'declaredWeightGrams'])(
  'blocks unconfirmed variant %s',
  async (field) => {
    const f = await fixture();
    (f.draft.variants[0] as any)[field].confirmed = false;
    const result = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
    expect(result.kind).toBe('blocked');
    expect(result.issues.some((i) => i.code === 'UNCONFIRMED_FACT')).toBe(true);
  },
);
it('returns every missing operating field without inventing defaults', async () => {
  const f = await fixture();
  f.input.choices = {} as any;
  f.input.stocks = {};
  const result = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(result.kind).toBe('blocked');
  expect(result.issues.map((i) => i.field)).toEqual(
    expect.arrayContaining([
      'categoryId',
      'brandId',
      'brandName',
      'logistics',
      'dimensionCm',
      'condition',
      'preOrder',
      'stockLocation',
      'stocks',
    ]),
  );
});
it('does not remap a saved listing to another price profile or sheet', async () => {
  const f = await fixture();
  f.input.priceSelection.priceProfile = 'SHOP MALL' as any;
  expect((await buildProductionDraftSource(f.repo, f.blobs, f.input, decision)).kind).toBe(
    'blocked',
  );
  f.input.priceSelection.priceProfile = null;
  f.input.priceSelection.sheet = 'Other';
  expect((await buildProductionDraftSource(f.repo, f.blobs, f.input, decision)).kind).toBe(
    'blocked',
  );
});
it('blocks price metadata tampering even if saved draft and parsed row are changed together', async () => {
  const f = await fixture();
  f.parsed.rows[0]!.originalPrice!.value = '1';
  f.draft.variants[0]!.originalPrice.value = '1';
  const result = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(result.kind).toBe('blocked');
  expect(result.issues.some((i) => i.code === 'PRICE_BYTES_MISMATCH')).toBe(true);
});
it('blocks absent or ambiguous saved price selections and extra stock SKUs', async () => {
  const f = await fixture();
  delete f.draft.sourceSelection;
  expect((await buildProductionDraftSource(f.repo, f.blobs, f.input, decision)).kind).toBe(
    'blocked',
  );
  const g = await fixture();
  g.parsed.rows.push(structuredClone(g.parsed.rows[0]!));
  expect((await buildProductionDraftSource(g.repo, g.blobs, g.input, decision)).kind).toBe(
    'blocked',
  );
  const h = await fixture();
  h.input.stocks['UNRELATED'] = 100;
  expect((await buildProductionDraftSource(h.repo, h.blobs, h.input, decision)).kind).toBe(
    'blocked',
  );
});
it('does not override a confirmed category, attribute or logistics fact', async () => {
  const f = await fixture();
  f.draft.categoryId = fact('99');
  expect((await buildProductionDraftSource(f.repo, f.blobs, f.input, decision)).kind).toBe(
    'blocked',
  );
  const g = await fixture();
  g.draft.attributes = { '111': fact(['222']) };
  expect((await buildProductionDraftSource(g.repo, g.blobs, g.input, decision)).kind).toBe(
    'blocked',
  );
  const h = await fixture();
  h.draft.logistics = { '50': fact(false) };
  expect((await buildProductionDraftSource(h.repo, h.blobs, h.input, decision)).kind).toBe(
    'blocked',
  );
});
it('checks actual image bytes and dimensions, not just stored descriptors', async () => {
  const f = await fixture();
  const image = f.draft.assets[0]!;
  f.bytes.set(image.sha256, new Uint8Array([1, 2]));
  expect((await buildProductionDraftSource(f.repo, f.blobs, f.input, decision)).kind).toBe(
    'blocked',
  );
  const g = await fixture();
  g.draft.assets[0]!.width = 99;
  expect((await buildProductionDraftSource(g.repo, g.blobs, g.input, decision)).kind).toBe(
    'blocked',
  );
});
it('rejects caller content replacements and preserves unresolved source issues', async () => {
  const f = await fixture();
  expect(
    (
      await buildProductionDraftSource(
        f.repo,
        f.blobs,
        { ...f.input, title: 'Replace source' },
        decision,
      )
    ).kind,
  ).toBe('blocked');
  f.draft.issues.push({
    code: 'SOURCE_CONFLICT',
    severity: 'block',
    field: 'ingredients',
    message: 'Unresolved source contradiction',
    sources: [decision],
  });
  const result = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(result.kind).toBe('blocked');
  expect(result.issues.some((i) => i.code === 'SOURCE_CONFLICT')).toBe(true);
});
it('blocks a supplied brand name that contradicts confirmed pricebook facts', async () => {
  const f = await fixture({ brand: 'Original brand' });
  const result = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(result.kind).toBe('blocked');
  expect(
    result.issues.some((i) => i.code === 'CONFIRMED_FACT_CONFLICT' && i.field === 'brandName'),
  ).toBe(true);
});
it('checks nominated cell provenance against the parser of the immutable original bytes', async () => {
  const f = await fixture();
  f.parsed.rows[0]!.originalPrice!.sources[0]!.locator = 'Prices!D2';
  const result = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(result.kind).toBe('blocked');
  expect(result.issues.some((i) => i.code === 'PRICE_CELL_PROVENANCE_MISMATCH')).toBe(true);
});
it('preserves exact SKU whitespace from raw Excel and blocks later identity normalization', async () => {
  const f = await fixture({ rawSku: ' A-100 ' });
  const result = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(result.kind).toBe('ready');
  if (result.kind === 'ready') expect(result.document.models[0]!.sku).toBe(' A-100 ');
  f.parsed.rows[0]!.sku.value = 'A-100';
  f.draft.variants[0]!.sku.value = 'A-100';
  const changed = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(changed.kind).toBe('blocked');
  expect(changed.issues.some((i) => i.code === 'PRICE_CELL_BYTES_MISMATCH')).toBe(true);
});
it('reuses confirmed category, brand, attribute IDs and logistics instead of requiring reentry', async () => {
  const f = await fixture({ brand: 'Source brand' });
  f.draft.categoryId = fact('10');
  f.draft.brandId = fact('20');
  f.draft.attributes = { '111': fact(['222', '223']) };
  f.draft.logistics = { '50': fact(true) };
  for (const field of ['categoryId', 'brandId', 'brandName', 'attributeList', 'logistics'])
    delete (f.input.choices as any)[field];
  const result = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') return;
  expect(result.document.categoryId).toBe('10');
  expect(result.document.brandId).toBe('20');
  expect(result.brandName).toBe('Source brand');
  expect(result.proposedAttributeList).toEqual([
    { attribute_id: 111, attribute_value_list: [{ value_id: 222 }, { value_id: 223 }] },
  ]);
  expect(result.document.logistics).toEqual([{ channelId: '50', enabled: true }]);
});
it('does not silently discard unsupported nested model shipping or content fields', async () => {
  const f = await fixture();
  (f.draft.variants[0] as any).dimensionCm = { length: 1, width: 2, height: 3 };
  const result = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(result.kind).toBe('blocked');
  expect(result.issues.some((i) => i.field === 'variants.0.dimensionCm')).toBe(true);
});
it('preserves a listing-specific duplicate authorization in the immutable preview input', async () => {
  const f = await fixture();
  const authorization = {
    reason: 'distinct_prepared_listing_test',
    authorizationReference: 'ten-listings-review/source-one/revision-4',
  };
  const result = await buildProductionDraftSource(
    f.repo,
    f.blobs,
    { ...f.input, existingListingAuthorization: authorization },
    decision,
  );
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') return;
  expect((result as any).existingListingAuthorization).toEqual(authorization);
  expect((result.sourceSnapshot.input as any).existingListingAuthorization).toEqual(authorization);
  const without = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(without.kind).toBe('ready');
  expect((without as any).existingListingAuthorization).toBeUndefined();
  expect(result.sourceFingerprint).not.toBe((without as any).sourceFingerprint);
});
it.each([
  { reason: 'allow_everything', authorizationReference: 'review' },
  { reason: 'distinct_prepared_listing_test', authorizationReference: '  ' },
  {
    reason: 'distinct_prepared_listing_test',
    authorizationReference: 'review',
    scope: 'all-products',
  },
])(
  'rejects malformed duplicate authorization rather than expanding it: %j',
  async (authorization) => {
    const f = await fixture();
    const result = await buildProductionDraftSource(
      f.repo,
      f.blobs,
      { ...f.input, existingListingAuthorization: authorization },
      decision,
    );
    expect(result.kind).toBe('blocked');
    expect(result.issues.some((i) => i.code === 'OPERATING_INPUT_INVALID')).toBe(true);
  },
);
it('blocks an invalid effective category ID even when it was saved as a confirmed fact', async () => {
  const f = await fixture();
  f.draft.categoryId = fact('0');
  delete (f.input.choices as any).categoryId;
  const result = await buildProductionDraftSource(f.repo, f.blobs, f.input, decision);
  expect(result.kind).toBe('blocked');
  expect(result.issues.some((i) => i.code === 'SOURCE_ID_INVALID')).toBe(true);
});
