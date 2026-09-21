import { createHash } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import { canonicalJson } from '@shopee/domain';
import { ProductionPreparationAutofillService } from '../../apps/api/src/production-preparation-autofill.js';

const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const scope = { environment: 'production', partnerId: '2010476', shopId: '1423724897' };
const fact = (value: any) => ({
  value,
  confirmed: true,
  sources: [
    {
      kind: 'product_file',
      fileSha256: 'a'.repeat(64),
      locator: 'DORIS!O2',
      observedAt: '2026-09-17T00:00:00Z',
    },
  ],
});
let drafts: any,
  rows: any[],
  history: any[],
  observations: any[],
  requests: any[],
  connection: any,
  meta: any,
  archived: boolean;
function draft(key = 'p', title = 'Nước Lau Sàn Hương Quế VINA TƯƠI 1 lít') {
  return {
    productKey: key,
    revision: 1,
    title: fact(title),
    description: [],
    attributes: {},
    logistics: {},
    assets: [],
    coverKey: 'c',
    galleryKeys: [],
    tierNames: ['Dung tích'],
    variants: [
      {
        key: 'v',
        sku: fact('SKU1'),
        optionLabels: ['1L'],
        originalPrice: fact('100000'),
        declaredWeightGrams: fact('503.8'),
      },
    ],
    sourceSelection: {
      title,
      headline: '',
      body: '',
      galleryIds: [],
      descriptionImageIds: [],
      tierNames: ['Dung tích'],
      variants: [
        { importId: '11111111-1111-4111-8111-111111111111', rowKey: 'mall1', optionLabels: ['1L'] },
      ],
    },
    issues: [],
  };
}
beforeEach(() => {
  drafts = { p: draft() };
  rows = [
    {
      key: 'mall1',
      sku: fact('SKU1'),
      brand: fact('VINA TƯƠI'),
      declaredWeightGrams: fact('503.8'),
    },
  ];
  history = [];
  observations = [];
  requests = [];
  archived = false;
  connection = {
    id: 'c',
    revision: 5,
    environment: 'production',
    partner_id: '2010476',
    shop_id: '1423724897',
    state: 'connected',
    expires_at: new Date(Date.now() + 600000),
  };
  meta = {
    scope,
    connectionRevision: 5,
    observedAt: new Date().toISOString(),
    shop: { id: '1423724897', name: 'Shop' },
    categoryAuthorizationVerified: false,
    categories: [
      { id: '101213', label: 'Chất tẩy rửa', path: 'Nhà cửa / Chất tẩy rửa', isLeaf: true },
      {
        id: '101127',
        label: 'Chất khử mùi, làm thơm',
        path: 'Nhà cửa / Chất khử mùi, làm thơm',
        isLeaf: true,
      },
      {
        id: '101162',
        label: 'Nến & đồ đựng nến',
        path: 'Nhà cửa / Nến & đồ đựng nến',
        isLeaf: true,
      },
    ],
    channels: [],
    brands: {
      items: [{ id: '1252097', name: 'VINA TƯƠI', label: 'VINA TƯƠI' }],
      hasNextPage: false,
      nextOffset: null,
      mandatory: true,
      inputType: null,
      searchComplete: true,
    },
    attributes: [
      {
        id: '100752',
        label: 'Loại chất làm sạch',
        mandatory: true,
        inputType: 'single_dropdown',
        values: [{ id: '4021', label: 'Chất tẩy rửa sàn', unit: null, children: [] }],
        maxValueCount: 1,
      },
    ],
    evidence: [],
  };
});
function service(transform?: (query: any, result: any) => any) {
  const repo: any = {
    getProduct: async (key: string) => structuredClone(drafts[key] ?? null),
    getImport: async () => ({
      kind: 'xlsx',
      status: 'ready',
      sha256: 'a'.repeat(64),
      body: { rows },
    }),
    pool: {
      query: async (sql: string) => {
        if (sql.includes('FROM connections')) return { rows: [connection] };
        if (sql.includes('FROM local_resource_archives'))
          return { rows: archived ? [{ one: 1 }] : [], rowCount: archived ? 1 : 0 };
        if (sql.includes('FROM production_pilot_operations')) return { rows: history };
        if (sql.includes('FROM seller_knowledge_items')) return { rows: observations };
        return { rows: [], rowCount: 0 };
      },
    },
  };
  return new ProductionPreparationAutofillService(repo, {
    auditRoot: false,
    metadata: async (query: any) => {
      requests.push(query);
      return transform ? transform(query, structuredClone(meta)) : structuredClone(meta);
    },
  });
}
it('stops an autofill cancelled during metadata lookup instead of continuing the batch', async () => {
  const controller = new AbortController();
  const subject = service((_query, result) => {
    controller.abort(new Error('operator-cancelled'));
    return result;
  });
  await expect(subject.recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] }, controller.signal))
    .rejects.toThrow('operator-cancelled');
  expect(requests).toHaveLength(1);
});
it('proposes only source-grounded fields; dimensions/NEW/preorder remain unknown', async () => {
  const r = await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] });
  const e = r.entries[0]!;
  expect(e.choices).toMatchObject({
    categoryId: '101213',
    brandId: '1252097',
    brandName: 'VINA TƯƠI',
    weightGrams: 503.8,
    attributeList: [{ attribute_id: 100752, attribute_value_list: [{ value_id: 4021 }] }],
  });
  expect(e.choices).not.toHaveProperty('dimensionCm');
  expect(e.choices).not.toHaveProperty('condition');
  expect(e.choices).not.toHaveProperty('preOrder');
  expect(e.unresolved.map((v) => v.field)).toEqual(
    expect.arrayContaining(['dimensionCm', 'condition', 'preOrder', 'stockLocation', 'logistics']),
  );
  expect(e.metadata?.categoryAuthorizationVerified).toBe(false);
});
it('shares exact-name metadata once per category and preserves supplied category constraints', async () => {
  drafts.q = draft('q');
  await service().recommend({
    entries: [
      { productKey: 'p', sourceRevision: 1 },
      { productKey: 'q', sourceRevision: 1 },
    ],
    shared: {
      condition: 'NEW',
      preOrder: { is_pre_order: false },
      dimensionCm: { length: 12, width: 12, height: 28 },
    },
  });
  expect(requests.filter((q) => q.brandName === 'VINA TƯƠI')).toHaveLength(1);
  const r = await service().recommend({
    entries: [{ productKey: 'p', sourceRevision: 1, categoryId: '101127' }],
  });
  expect(r.entries[0]!.choices.categoryId).toBe('101127');
  expect(r.entries[0]!.choices.attributeList).toBeUndefined();
});
it('does not infer category from partial SKU overlap or a historical cross-product conflict', async () => {
  drafts.p.title = fact('Bộ tinh dầu VINA TƯƠI');
  drafts.p.variants.push({ ...drafts.p.variants[0], key: 'v2', sku: fact('SKU2') });
  drafts.p.sourceSelection.variants.push({
    ...drafts.p.sourceSelection.variants[0],
    rowKey: 'mall2',
  });
  rows.push({ ...rows[0], key: 'mall2', sku: fact('SKU2') });
  observations = [
    {
      body: { modelSkus: ['SKU1'], skuIdentityComplete: true, categoryId: '101127' },
      evidence_id: 'old',
    },
  ];
  expect(
    (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] })).entries[0]!
      .choices.categoryId,
  ).toBeUndefined();
  observations = [
    {
      body: { modelSkus: ['SKU1', 'SKU2'], skuIdentityComplete: true, categoryId: '101127' },
      evidence_id: 'a',
    },
    {
      body: { modelSkus: ['SKU1', 'SKU2'], skuIdentityComplete: true, categoryId: '101213' },
      evidence_id: 'b',
    },
  ];
  expect(
    (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] })).entries[0]!
      .choices.categoryId,
  ).toBeUndefined();
});
it('rejects stale revision/archive and does not carry partial or mismatched weight/brand rows', async () => {
  expect(
    (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 2 }] })).entries[0]!
      .issues[0]?.code,
  ).toBe('SOURCE_REVISION_CHANGED');
  rows[0].sku = fact('OTHER');
  const e = (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] }))
    .entries[0]!;
  expect(e.choices.weightGrams).toBeUndefined();
  expect(e.choices.brandId).toBeUndefined();
  archived = true;
  expect(
    (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] })).entries[0]!
      .issues[0]?.code,
  ).toBe('LOCAL_RESOURCE_ARCHIVED');
});
it('invalidates source changed during metadata reads instead of applying old proposals', async () => {
  const s = service((q, m) => {
    if (q.brandName) drafts.p.revision = 2;
    return m;
  });
  const e = (await s.recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] })).entries[0]!;
  expect(e.choices).toEqual({});
  expect(e.issues[0]?.code).toBe('SOURCE_REVISION_CHANGED');
});
it('rejects changed connection across shared metadata reads', async () => {
  await expect(
    service((q, m) => ({ ...m, connectionRevision: q.categoryId ? 6 : 5 })).recommend({
      entries: [{ productKey: 'p', sourceRevision: 1 }],
    }),
  ).rejects.toThrow('PRODUCTION_PREPARATION_CONNECTION_CHANGED');
});
function verifiedHistory() {
  const document = {
    models: [{ sku: 'OLD' }],
    logistics: [
      { channelId: '10', enabled: true },
      { channelId: '11', enabled: true },
    ],
  };
  const payload = {
    connectionId: 'c',
    connectionRevision: 4,
    sourceIdentity: 'old',
    sourceRevision: 1,
    document,
  };
  const projection = { item: {}, models: [] };
  const reads = [1, 2].map((i) => ({
    observedAt: `2026-09-17T00:00:0${i}Z`,
    shopId: '1423724897',
    partnerId: '2010476',
    itemId: '777',
    requestIds: ['r' + i],
    raw: { i },
    rawSha256: hash({ i }),
    projection,
    projectionSha256: hash(projection),
  }));
  return {
    operation: {
      id: 'op',
      revision: 2,
      state: 'verified',
      item_id: '777',
      owner_key: 'production:2010476:1423724897',
      connection_id: 'c',
      connection_revision: 4,
      source_identity: 'old',
      source_revision: 1,
      source_payload: payload,
      expected_projection: projection,
      source_fingerprint: hash({
        scope,
        sourceIdentity: 'old',
        sourceRevision: 1,
        sourcePayload: payload,
        expectedProjection: projection,
      }),
    },
    verification: {
      operation_id: 'op',
      operation_revision: 1,
      item_id: '777',
      phase: 'created_unlisted',
      expected_fingerprint: hash(projection),
      readbacks: reads,
      evidence_fingerprint: hash(reads),
    },
  };
}
it('maps every current SKU only from fresh verified warehouse proof and filters channel package fit', async () => {
  history = [verifiedHistory()];
  meta.reference = {
    itemId: '777',
    title: 'Old',
    writeMappingVerified: true,
    writeMapping: {
      expectedLocationId: 'VNZ',
      writeLocationId: null,
      verifiedOperationId: 'op',
      verificationFingerprint: history[0].verification.evidence_fingerprint,
    },
    stockLocations: [],
  };
  const channel = {
    id: '10',
    name: 'A',
    enabled: true,
    forceEnabled: false,
    compulsory: false,
    feeType: 'SIZE_INPUT',
    parentId: '0',
    weightKg: { min: 0, max: 5 },
    maxDimension: { height: 100, width: 100, length: 100, sum: 300, unit: 'cm' },
    volume: { min: null, max: null },
    relatedEnabledChannelIds: [],
    dependentBlockChannelIds: [],
    relationsKnown: true,
  };
  meta.channels = [channel, { ...channel, id: '11', weightKg: { min: 0, max: 0.2 } }];
  const e = (
    await service().recommend({
      entries: [{ productKey: 'p', sourceRevision: 1 }],
      shared: { dimensionCm: { length: 12, width: 12, height: 28 } },
    })
  ).entries[0]!;
  expect(e.choices.stockLocation).toEqual({
    referenceItemId: '777',
    expectedLocationBySku: { SKU1: 'VNZ' },
    writeLocationBySku: { SKU1: null },
  });
  expect(e.choices.logistics).toEqual([{ channelId: '10', enabled: true }]);
  meta.reference.writeMappingVerified = false;
  const rejected = (
    await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] })
  ).entries[0]!;
  expect(rejected.choices.stockLocation).toBeUndefined();
  expect(rejected.choices.logistics).toBeUndefined();
});
it('fills all eligible product groups without historical logistics and respects each existing package', async () => {
  const channel = {id:'10',name:'Nhanh',enabled:true,parentId:'0',forceEnabled:false,compulsory:false,
    feeType:'SIZE_INPUT',relationsKnown:true,relatedEnabledChannelIds:[],dependentBlockChannelIds:[],
    weightKg:{min:0,max:10},maxDimension:{height:30,width:30,length:30,sum:0,unit:'cm'},volume:{min:0,max:0}};
  meta.channels=[channel,{...channel,id:'11',parentId:'10'}, {...channel,id:'12',maxDimension:{...channel.maxDimension,height:8}}];
  const result=await service().recommend({entries:[{productKey:'p',sourceRevision:1}],logisticsMode:'all_eligible',
    shared:{dimensionCm:{length:12,width:12,height:28}}});
  expect(result.entries[0]!.choices.logistics).toEqual([{channelId:'10',enabled:true}]);
  expect(result.entries[0]!.explanations.some(e=>e.field==='logistics' && e.message.includes('giới hạn'))).toBe(true);
  const larger=await service().recommend({entries:[{productKey:'p',sourceRevision:1,dimensionCm:{length:40,width:40,height:40}}],
    logisticsMode:'all_eligible',shared:{dimensionCm:{length:12,width:12,height:28}}});
  expect(larger.entries[0]!.choices.logistics).toBeUndefined();
});
it('does not copy historical attributes or use a truncated brand search', async () => {
  meta.brands.searchComplete = false;
  meta.attributes[0].label = 'Xuất xứ';
  const e = (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] }))
    .entries[0]!;
  expect(e.choices.brandId).toBeUndefined();
  expect(e.choices.attributeList).toBeUndefined();
});
it('accepts zero limit sentinels but rejects positive package limits and wrong logistics proof', async () => {
  history = [verifiedHistory()];
  meta.reference = {
    itemId: '777',
    writeMappingVerified: true,
    writeMapping: {
      expectedLocationId: 'VNZ',
      writeLocationId: null,
      verifiedOperationId: 'op',
      verificationFingerprint: history[0].verification.evidence_fingerprint,
    },
  };
  const channel = {
    id: '10',
    name: 'A',
    enabled: true,
    forceEnabled: false,
    compulsory: false,
    feeType: 'SIZE_INPUT',
    parentId: '0',
    weightKg: { min: 0, max: 0 },
    maxDimension: { height: 0, width: 0, length: 0, sum: 0, unit: 'cm' },
    volume: { min: 0, max: 0 },
    relatedEnabledChannelIds: [],
    dependentBlockChannelIds: [],
    relationsKnown: true,
  };
  const request = {
    entries: [{ productKey: 'p', sourceRevision: 1 }],
    shared: { dimensionCm: { length: 12, width: 12, height: 28 } },
  };
  meta.channels = [channel];
  expect((await service().recommend(request)).entries[0]!.choices.logistics).toEqual([
    { channelId: '10', enabled: true },
  ]);
  for (const patch of [
    { weightKg: { min: 0, max: 0.2 } },
    { maxDimension: { ...channel.maxDimension, sum: 50 } },
    { maxDimension: { ...channel.maxDimension, height: 20 } },
    { volume: { min: 0, max: 10 } },
  ]) {
    meta.channels = [{ ...channel, ...patch }];
    expect((await service().recommend(request)).entries[0]!.choices.logistics).toBeUndefined();
  }
  meta.channels = [channel];
  meta.reference.writeMapping.verificationFingerprint = '0'.repeat(64);
  expect((await service().recommend(request)).entries[0]!.choices.logistics).toBeUndefined();
});
it('uses real same-shop exact-SKU evidence for safe packaging and shows sensitive facts unapplied', async () => {
  const attr = (id: string, label: string, valueId: string, valueLabel: string) => ({
    id,
    label,
    mandatory: false,
    inputType: 'single_dropdown',
    inputTypeCode: 1,
    validationType: 0,
    formatType: 1,
    units: [],
    maxValueCount: 1,
    values: [{ id: valueId, label: valueLabel, unit: null, children: [] }],
  });
  meta.attributes = [
    attr('100016', 'Kiểu đóng gói', '394', 'Đơn'),
    attr('100037', 'Xuất xứ', '136', 'Việt Nam'),
  ];
  observations = [
    {
      evidence_id: 'e1',
      scope,
      observed_at: new Date().toISOString(),
      body: {
        itemId: '123',
        title: 'Nước Lau Sàn Hương Quế 1 lít',
        categoryId: '101213',
        brandId: '1252097',
        itemStatus: 'NORMAL',
        models: [{ model_sku: 'SKU1', model_id: 1 }],
        attributes: [
          { attribute_id: 100016, attribute_value_list: [{ value_id: 394 }] },
          { attribute_id: 100037, attribute_value_list: [{ value_id: 136 }] },
        ],
      },
    },
  ];
  const e = (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] }))
    .entries[0]!;
  expect(e.choices.attributeList).toEqual([
    { attribute_id: 100016, attribute_value_list: [{ value_id: 394, original_value_name: 'Đơn' }] },
  ]);
  expect(e.knowledgeSuggestions?.find((s) => s.attributeId === 100037)).toMatchObject({
    applied: false,
    confidence: 'reference',
    canPrefill: false,
    references: [{ itemId: '123', evidenceId: 'e1' }],
  });
  expect(e.explanations.some((x) => x.source?.includes('item 123; evidence e1'))).toBe(true);
  observations[0].body.title = 'Xịt khử mùi phòng ngủ';
  expect(
    (
      await service().recommend({
        entries: [{ productKey: 'p', sourceRevision: 1, categoryId: '101213' }],
      })
    ).entries[0]!.choices.attributeList,
  ).toBeUndefined();
});
it('does not choose one volume for mixed-size models and derives common volume without ordinal assumptions', async () => {
  meta.attributes = [
    {
      id: '100248',
      label: 'Thể tích',
      mandatory: false,
      inputType: 'single_combobox',
      inputTypeCode: 2,
      validationType: 3,
      formatType: 2,
      units: ['ml', 'L'],
      maxValueCount: null,
      values: [],
    },
  ];
  const first = (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] }))
    .entries[0]!;
  expect(first.choices.attributeList).toEqual([
    {
      attribute_id: 100248,
      attribute_value_list: [{ value_id: 0, original_value_name: '1000', value_unit: 'ml' }],
    },
  ]);
  drafts.p.variants.push({
    ...drafts.p.variants[0],
    key: 'v2',
    sku: fact('SKU2'),
    optionLabels: ['300ml'],
  });
  drafts.p.sourceSelection.variants.push({
    ...drafts.p.sourceSelection.variants[0],
    rowKey: 'mall2',
    optionLabels: ['300ml'],
  });
  rows.push({ ...rows[0], key: 'mall2', sku: fact('SKU2') });
  expect(
    (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] })).entries[0]!
      .choices.attributeList,
  ).toBeUndefined();
});
it('leaves shoe and car categories unresolved instead of treating all sprays as household deodorizer', async () => {
  for (const title of ['Xịt khử mùi giày da nam VINA TƯƠI', 'Xịt thơm ô tô VINA TƯƠI']) {
    drafts.p.title = fact(title);
    expect(
      (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] })).entries[0]!
        .choices.categoryId,
    ).toBeUndefined();
  }
});
it('does not let a different-use car listing override or block the source room category for shared SKUs', async () => {
  drafts.p.title = fact('Xịt thơm phòng ngủ VINA TƯƠI');
  observations = [
    {
      evidence_id: 'car',
      scope,
      observed_at: new Date().toISOString(),
      body: {
        itemId: '777',
        title: 'Xịt thơm ô tô VINA TƯƠI',
        categoryId: '102572',
        brandId: '1252097',
        itemStatus: 'NORMAL',
        models: [{ model_sku: 'SKU1', model_id: 1 }],
        attributes: [],
      },
    },
  ];
  expect(
    (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] })).entries[0]!
      .choices.categoryId,
  ).toBe('101127');
});
it('maps an explicit liquid declaration without treating a plastic bottle as pack quantity', async () => {
  meta.attributes = [
    {
      id: '100036',
      label: 'Công Thức',
      mandatory: false,
      inputType: 'single_combobox',
      inputTypeCode: 2,
      validationType: 2,
      formatType: 1,
      units: [],
      maxValueCount: null,
      values: [{ id: '708', label: 'Dạng Lỏng', unit: null, children: [] }],
    },
    {
      id: '101306',
      label: 'Quantity per Pack',
      mandatory: false,
      inputType: 'single_combobox',
      inputTypeCode: 2,
      validationType: 0,
      formatType: 1,
      units: [],
      maxValueCount: null,
      values: [{ id: '11855', label: '1', unit: null, children: [] }],
    },
  ];
  drafts.p.description = [
    { type: 'text', text: '📦 THÔNG TIN\nDạng dung dịch pha loãng, chai nhựa 1 lít có nắp vặn.' },
  ];
  expect(
    (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] })).entries[0]!
      .choices.attributeList,
  ).toEqual([{ attribute_id: 100036, attribute_value_list: [{ value_id: 708 }] }]);
  drafts.p.description = [
    { type: 'text', text: 'Không phải dạng dung dịch; chai được bán riêng.' },
  ];
  expect(
    (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] })).entries[0]!
      .choices.attributeList,
  ).toBeUndefined();
});
it('canonicalizes known positive historical value IDs without mutating raw labels, and exposes rejected evidence', async () => {
  const attr = (id: string, label: string, valueId: string, valueLabel: string) => ({
    id,
    label,
    mandatory: false,
    inputType: 'single_dropdown',
    inputTypeCode: 1,
    validationType: 0,
    formatType: 1,
    units: [],
    maxValueCount: 1,
    values: [{ id: valueId, label: valueLabel, unit: null, children: [] }],
  });
  drafts.p.title = fact('Xịt thơm phòng ngủ VINA TƯƠI');
  meta.attributes = [
    attr('100016', 'Kiểu đóng gói', '394', 'Đơn'),
    attr('101050', 'Điều kiện bảo quản', '6231', 'Điều kiện thường'),
  ];
  observations = [
    {
      evidence_id: 'english',
      scope,
      observed_at: new Date().toISOString(),
      body: {
        itemId: '123',
        title: 'Xịt khử mùi phòng ngủ VINA TƯƠI',
        categoryId: '101127',
        brandId: '1252097',
        itemStatus: 'NORMAL',
        models: [{ model_sku: 'SKU1', model_id: 1 }],
        attributes: [
          {
            attribute_id: 100016,
            attribute_value_list: [{ value_id: 394, original_value_name: 'Single' }],
          },
          {
            attribute_id: 101050,
            attribute_value_list: [{ value_id: 6231, original_value_name: 'Normal' }],
          },
          {
            attribute_id: 777777,
            attribute_value_list: [{ value_id: 1, original_value_name: 'Unknown' }],
          },
        ],
      },
    },
  ];
  const before = JSON.stringify(observations);
  const e = (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] }))
    .entries[0]!;
  expect(e.choices.attributeList?.map((a) => a.attribute_id)).toEqual([100016, 101050]);
  expect(e.knowledgeIssues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'UNKNOWN_ATTRIBUTE', attributeId: 777777 }),
    ]),
  );
  expect(e.knowledgeSuggestions?.every((s) => s.confidence === 'reference')).toBe(true);
  expect(JSON.stringify(observations)).toBe(before);
});
it('uses literal per-choice bottle count and ordinary storage text, not a volume or negated declaration', async () => {
  const attr = (id: string, label: string, valueId: string, valueLabel: string) => ({
    id,
    label,
    mandatory: false,
    inputType: 'single_dropdown',
    inputTypeCode: 1,
    validationType: 0,
    formatType: 1,
    units: [],
    maxValueCount: 1,
    values: [{ id: valueId, label: valueLabel, unit: null, children: [] }],
  });
  meta.attributes = [
    attr('100016', 'Kiểu đóng gói', '394', 'Đơn'),
    attr('101306', 'Quantity per Pack', '11855', '1'),
    attr('101050', 'Điều kiện bảo quản', '6231', 'Điều kiện thường'),
  ];
  drafts.p.description = [
    {
      type: 'text',
      text: 'Chọn cỡ theo nhu cầu; mỗi lựa chọn gồm 1 chai.\nCất nơi khô thoáng, tránh nắng chiếu thẳng.',
    },
  ];
  const e = (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] }))
    .entries[0]!;
  expect(e.choices.attributeList?.map((a) => a.attribute_id)).toEqual([100016, 101306, 101050]);
  drafts.p.description = [
    {
      type: 'text',
      text: 'Không phải mỗi lựa chọn gồm 1 chai.\nKhông bảo quản ở nơi khô thoáng.\nChai nhựa 1 lít.',
    },
  ];
  expect(
    (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] })).entries[0]!
      .choices.attributeList,
  ).toBeUndefined();
});
it('recognizes alternate room-spray title positions only with matching instructions and all source SKU names', async () => {
  rows[0].name = fact('Tinh dầu xịt cao cấp Hoa hồng VNT 100ml');
  drafts.p.description = [
    {
      type: 'text',
      text: 'Dung dịch pha sẵn, có vòi xịt. Xịt lên rèm, đệm ghế và khoảng không giữa phòng.',
    },
  ];
  for (const title of [
    'Chai Xịt Tinh Dầu VINA TƯƠI - Thơm Phòng Ngủ Và Khu Vệ Sinh',
    'Xịt Phòng Tinh Dầu VINA TƯƠI 16 Hương',
    'Thơm Phòng Toả Hương VINA TƯƠI - Chai Xịt Tinh Dầu Cho Sofa',
    'Tinh Dầu Sả Chanh Xịt Thơm Phòng Ngủ VINA TƯƠI',
    'Xịt Phòng Khử Mùi Hôi VINA TƯƠI - Phòng Trọ',
    'Xịt Phòng Khử Mùi Khách Sạn VINA TƯƠI',
  ]) {
    drafts.p.title = fact(title);
    expect(
      (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] })).entries[0]!
        .choices.categoryId,
    ).toBe('101127');
  }
});
it('does not extend room classification from title alone, missing SKU proof, or another product use', async () => {
  drafts.p.title = fact('Chai Xịt Tinh Dầu VINA TƯƠI - Thơm Phòng Ngủ');
  rows[0].name = fact('Tinh dầu xịt cao cấp Hoa hồng 100ml');
  expect(
    (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] })).entries[0]!
      .choices.categoryId,
  ).toBeUndefined();
  drafts.p.description = [{ type: 'text', text: 'Xịt lên rèm và sofa trong phòng.' }];
  rows[0].name = fact('Tinh dầu nguyên chất 100ml');
  expect(
    (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] })).entries[0]!
      .choices.categoryId,
  ).toBeUndefined();
  rows[0].name = fact('Tinh dầu xịt cao cấp Hoa hồng 100ml');
  for (const title of [
    'Chai Xịt Tinh Dầu Cho Ô Tô - Thơm Phòng',
    'Chai Xịt Khử Mùi Giày Để Trong Phòng',
    'Chai Xịt Lau Bàn Ăn Trong Phòng',
    'Nước Lau Sàn Cho Phòng Ngủ',
    'Nến Thơm Cho Phòng',
  ]) {
    drafts.p.title = fact(title);
    expect(
      (await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] })).entries[0]!
        .choices.categoryId,
    ).not.toBe('101127');
  }
});
it('minimum mode skips optional inference and KB attributes, retaining mandatory source facts and unresolved requirements', async () => {
  const required = { ...meta.attributes[0] };
  const optional = {
    ...required,
    id: '100036',
    label: 'Công Thức',
    mandatory: false,
    values: [{ id: '708', label: 'Dạng Lỏng', unit: null, children: [] }],
  };
  meta.attributes = [
    required,
    optional,
    {
      ...required,
      id: '900',
      label: 'Chi tiết chưa có trong nguồn',
      values: [{ id: '1', label: 'Một lựa chọn', unit: null, children: [] }],
    },
  ];
  drafts.p.description = [{ type: 'text', text: 'Dạng dung dịch pha loãng.' }];
  const r = await service().recommend({
    entries: [{ productKey: 'p', sourceRevision: 1 }],
    attributeMode: 'minimum_required',
  });
  expect(r.attributeMode).toBe('minimum_required');
  expect(r.entries[0]!.choices.attributeList?.map((a) => a.attribute_id)).toEqual([100752]);
  expect(r.entries[0]!.knowledgeSuggestions).toBeUndefined();
  expect(r.entries[0]!.unresolved).toContainEqual(
    expect.objectContaining({ field: 'attributes.900' }),
  );
  const legacy = await service().recommend({ entries: [{ productKey: 'p', sourceRevision: 1 }] });
  expect(legacy.attributeMode).toBe('source_supported');
  expect(legacy.entries[0]!.choices.attributeList?.map((a) => a.attribute_id)).toEqual([
    100752, 100036,
  ]);
});
it('uses corroborated closet, vehicle and surface-cleaner purposes with current category labels, never footwear fallback', async () => {
  meta.categories.push({
    id: '9876',
    label: 'Nước hoa xe',
    path: 'Ô tô / Nước hoa xe',
    isLeaf: true,
  });
  const cases = [
    [
      'Xịt Tủ Giày Và Túi Đồ Tập VINA TƯƠI',
      'Xịt vào hộc tủ giày và lòng ngăn tủ.',
      'Tinh dầu xịt Hoa hồng VNT 100ml',
      '101127',
    ],
    [
      'Xịt Thơm Xe Ô Tô Hương Quế VINA TƯƠI',
      'Xịt lên ghế xe và trong khoang xe.',
      'Tinh dầu xịt Vỏ Quế VNT 100ml',
      '9876',
    ],
    [
      'Sả Chanh Dung Dịch Lau Đa Năng Chai Xịt',
      'Dung dịch xịt lên mặt bàn và tay nắm cửa.',
      'Dung dịch Sả Chanh VNT 100ml',
      '101213',
    ],
  ];
  for (const [title, body, name, category] of cases) {
    drafts.p.title = fact(title!);
    drafts.p.description = [{ type: 'text', text: body }];
    rows[0].name = fact(name!);
    expect(
      (
        await service().recommend({
          entries: [{ productKey: 'p', sourceRevision: 1 }],
          attributeMode: 'minimum_required',
        })
      ).entries[0]!.choices.categoryId,
    ).toBe(category);
  }
  drafts.p.title = fact('Xịt Khử Mùi Giày Da Nam');
  drafts.p.description = [{ type: 'text', text: 'Xịt vào lòng giày. Có thể cất cạnh hộc tủ.' }];
  rows[0].name = fact('Tinh dầu xịt Vỏ Quế VNT 100ml');
  expect(
    (
      await service().recommend({
        entries: [{ productKey: 'p', sourceRevision: 1 }],
        attributeMode: 'minimum_required',
      })
    ).entries[0]!.choices.categoryId,
  ).toBeUndefined();
});
