import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { Pool, Repository, BlobStore, migrate } from '../../packages/persistence/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { SellerKnowledgeService } from '../../apps/api/src/seller-knowledge-service.js';
import { SellerKnowledgeFacts } from '../../apps/api/src/seller-knowledge-facts.js';
import {
  SellerKnowledgeDraftService,
  validateDraftKnowledgeAcceptance,
} from '../../apps/api/src/seller-knowledge-draft-service.js';

const schema = 'test_knowledge_draft_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
});
const repo = new Repository(pool);
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

async function fixture(
  options: {
    confirmed?: boolean;
    sourceKind?: string;
    existing?: boolean;
    conflictingFact?: boolean;
    attributes?: Record<string, string>;
    tree?: any[];
    conflictingItemId?: boolean;
  } = {},
) {
  let now = Date.now();
  const connectionId = randomUUID(),
    productKey = randomUUID(),
    shopId = String(Math.floor(Math.random() * 1e9));
  await pool.query(
    `INSERT INTO connections(id,environment,partner_id,shop_id,name,state,expires_at) VALUES($1,'production','9',$2,'Shop riêng','connected',now()+interval '2 hours')`,
    [connectionId, shopId],
  );
  const source = {
    kind: options.sourceKind ?? 'product_file',
    fileSha256: 'a'.repeat(64),
    locator: 'Word: thuộc tính 7',
    observedAt: new Date(now).toISOString(),
  };
  const fact = (value: any) => ({ value, confirmed: true, sources: [source] });
  const draft: any = {
    productKey,
    revision: 1,
    title: fact('Tinh dầu nguyên bản'),
    description: [],
    coverKey: 'cover',
    galleryKeys: [],
    tierNames: [],
    assets: [],
    issues: [],
    logistics: {},
    categoryId: fact('12'),
    brandId: fact('3'),
    variants: [{ key: 'one', sku: fact('SKU1'), optionLabels: [], originalPrice: fact('10000') }],
    attributes: Object.fromEntries(
      Object.entries(options.attributes ?? { '7': '8' }).map(([id, value]) => [
        id,
        { ...fact(value), confirmed: options.confirmed ?? true },
      ]),
    ),
    ...(options.existing
      ? {
          sourceListingId: fact(options.conflictingItemId ? null : '1'),
          sourceSelection: { sourceListingId: '1' },
        }
      : {}),
  };
  await pool.query('INSERT INTO products(product_key,latest_revision) VALUES($1,1)', [productKey]);
  await pool.query('INSERT INTO product_revisions(product_key,revision,body) VALUES($1,1,$2)', [
    productKey,
    draft,
  ]);
  const calls: string[] = [];
  const knowledge = new SellerKnowledgeService(repo, {
    autoRun: false,
    sleep: async () => {},
    now: () => now,
    read: async (_scope, path, query) => {
      calls.push(path);
      const response = path.endsWith('get_item_list')
        ? {
            item:
              query.item_status === 'NORMAL'
                ? [{ item_id: 1, item_status: 'NORMAL', update_time: 1 }]
                : [],
            has_next_page: false,
          }
        : path.endsWith('get_item_base_info')
          ? {
              item_list: [
                {
                  item_id: 1,
                  item_name: 'Nguồn lịch sử',
                  item_sku: 'SKU1',
                  category_id: 12,
                  brand: { brand_id: 3 },
                  item_status: 'NORMAL',
                  update_time: 1,
                  has_model: false,
                  attribute_list: [{ attribute_id: 7, attribute_value_list: [{ value_id: 9 }] }],
                },
              ],
            }
          : path.endsWith('get_category')
            ? {
                category_list: [
                  {
                    category_id: 12,
                    parent_category_id: 0,
                    display_category_name: 'Tinh dầu',
                    has_children: false,
                  },
                ],
              }
            : {
                list: [
                  {
                    category_id: 12,
                    attribute_tree: options.tree ?? [
                      {
                        attribute_id: 7,
                        name: 'Loại',
                        mandatory: true,
                        attribute_info: { input_type: 1, input_validation_type: 0, format_type: 1 },
                        attribute_value_list: [
                          { value_id: 8, name: 'Nguồn sản phẩm' },
                          { value_id: 9, name: 'Nguồn khác' },
                        ],
                      },
                    ],
                  },
                ],
              };
      return { kind: 'success', response, requestId: randomUUID() };
    },
  });
  const job = await knowledge.startSync({ connectionId, requestId: randomUUID() });
  await knowledge.runSync(job.id);
  const facts = new SellerKnowledgeFacts(repo);
  if (options.conflictingFact) {
    const observed = (await knowledge.search({ connectionId }))[0]!;
    await facts.save(
      {
        requestId: randomUUID(),
        connectionId,
        evidenceId: observed.evidenceId,
        sourceReference: 'user-decision: exact item',
        facts: [{ attributeId: 7, values: [{ valueId: 9 }] }],
      },
      observed,
    );
  }
  const service = new SellerKnowledgeDraftService(repo, knowledge, facts, { now: () => now });
  const target = { productKey, expectedRevision: 1, connectionId, categoryId: 12, brandId: 3 };
  const accept = async () => {
    const result = await service.recommend(target);
    return service.accept({
      ...target,
      requestId: randomUUID(),
      recommendationFingerprint: result.fingerprint,
      attributeIds: [7],
    });
  };
  return {
    service,
    knowledge,
    facts,
    target,
    draft,
    calls,
    accept,
    setNow: (value: number) => {
      now = value;
    },
    getNow: () => now,
  };
}

it('offers only confirmed product facts, keeps source content untouched, and durably binds an explicit acceptance', async () => {
  const f = await fixture(),
    before = await repo.getProduct(f.target.productKey);
  const result = await f.service.recommend(f.target);
  expect(result.target).toMatchObject({
    productKey: f.target.productKey,
    expectedRevision: 1,
    scope: { shopId: expect.any(String) },
  });
  expect(result.recommendations.suggestions[0]).toMatchObject({
    sourceClass: 'product_source',
    canPrefill: true,
    values: [{ valueId: 8 }],
  });
  expect(result.sourceFacts[0]?.sourceLocator).toContain('Word: thuộc tính 7');
  const request = {
    ...f.target,
    requestId: randomUUID(),
    recommendationFingerprint: result.fingerprint,
    attributeIds: [7],
  };
  const receipt = await f.service.accept(request);
  expect(await f.service.accept(request)).toEqual(receipt);
  expect(receipt).toMatchObject({
    localOnly: true,
    shopMutations: 0,
    attributeList: [{ attribute_id: 7, attribute_value_list: [{ value_id: 8 }] }],
  });
  const proof = await validateDraftKnowledgeAcceptance(repo, {
    receiptId: receipt.id,
    productKey: f.target.productKey,
    expectedRevision: 1,
    categoryId: '12',
    brandId: '3',
    scope: result.target.scope,
    attributeList: receipt.attributeList,
  });
  expect(proof.fingerprint).toBe(receipt.fingerprint);
  expect(await repo.getProduct(f.target.productKey)).toEqual(before);
  await expect(
    pool.query('UPDATE seller_knowledge_draft_acceptances SET body=body WHERE id=$1', [receipt.id]),
  ).rejects.toThrow();
});

it.each([
  { confirmed: false },
  { sourceKind: 'seller_observation' },
  { sourceKind: 'official_doc' },
])('never turns unconfirmed or nonproduct provenance into prefill: %j', async (options) => {
  const f = await fixture(options),
    result = await f.service.recommend(f.target);
  expect(result.sourceFacts).toEqual([]);
  expect(result.recommendations.suggestions.every((s: any) => !s.canPrefill)).toBe(true);
  await expect(f.accept()).rejects.toThrow('KNOWLEDGE_DRAFT_SELECTION_NOT_CONFIRMED');
});

it('does not transfer facts from a same-SKU existing item to a new blank-ID draft', async () => {
  const f = await fixture({ confirmed: false, conflictingFact: true });
  const result = await f.service.recommend(f.target);
  expect(result.sourceFacts).toEqual([]);
  expect(result.recommendations.suggestions[0]?.canPrefill).toBe(false);
});

it('blocks conflicting confirmed draft and exact existing-item facts', async () => {
  const f = await fixture({ existing: true, conflictingFact: true }),
    result = await f.service.recommend(f.target);
  expect(result.sourceFacts).toHaveLength(2);
  expect(result.recommendations.suggestions[0]).toMatchObject({
    canPrefill: false,
    confidence: 'blocked',
  });
  await expect(f.accept()).rejects.toThrow('KNOWLEDGE_DRAFT_SELECTION_NOT_CONFIRMED');
});

it('rejects a blank authoritative item ID that conflicts with a selected existing ID', async () => {
  const f = await fixture({
    existing: true,
    conflictingItemId: true,
    confirmed: false,
    conflictingFact: true,
  });
  await expect(f.service.recommend(f.target)).rejects.toThrow('KNOWLEDGE_DRAFT_ITEM_ID_CONFLICT');
});

it('validates dependent attributes against the actually accepted selection, not unselected facts', async () => {
  const info = { input_type: 1, input_validation_type: 0, format_type: 1 };
  const f = await fixture({
    attributes: { '7': '8', '10': '11' },
    tree: [
      {
        attribute_id: 7,
        name: 'Nhóm',
        mandatory: true,
        attribute_info: info,
        attribute_value_list: [
          {
            value_id: 8,
            name: 'Có chi tiết',
            child_attribute_list: [
              {
                attribute_id: 10,
                name: 'Chi tiết bắt buộc',
                mandatory: true,
                attribute_info: info,
                attribute_value_list: [{ value_id: 11, name: 'Đã xác nhận' }],
              },
            ],
          },
        ],
      },
    ],
  });
  const result = await f.service.recommend(f.target);
  expect(result.recommendations.suggestions.filter((row) => row.canPrefill)).toHaveLength(2);
  for (const attributeIds of [[7], [10]])
    await expect(
      f.service.accept({
        ...f.target,
        requestId: randomUUID(),
        recommendationFingerprint: result.fingerprint,
        attributeIds,
      }),
    ).rejects.toThrow('KNOWLEDGE_DRAFT_SCHEMA_CHANGED');
  const accepted = await f.service.accept({
    ...f.target,
    requestId: randomUUID(),
    recommendationFingerprint: result.fingerprint,
    attributeIds: [7, 10],
  });
  expect(accepted.attributeList).toHaveLength(2);
});

it('invalidates an accepted existing-item fact when a newer confirmation supersedes it', async () => {
  const f = await fixture({ confirmed: false, existing: true, conflictingFact: true }),
    accepted = await f.accept();
  const observed = (await f.knowledge.search({ connectionId: f.target.connectionId }))[0]!;
  await f.facts.save(
    {
      requestId: randomUUID(),
      connectionId: f.target.connectionId,
      evidenceId: observed.evidenceId,
      sourceReference: 'new user correction for same item',
      facts: [{ attributeId: 7, values: [{ valueId: 8 }] }],
    },
    observed,
  );
  await expect(
    validateDraftKnowledgeAcceptance(repo, {
      receiptId: accepted.id,
      productKey: f.target.productKey,
      expectedRevision: 1,
      categoryId: '12',
      brandId: '3',
      attributeList: accepted.attributeList,
    }),
  ).rejects.toThrow('KNOWLEDGE_DRAFT_FACTS_CHANGED');
});

it('keeps receipts scoped to the selected shop and rejects use in another shop', async () => {
  const a = await fixture(),
    b = await fixture(),
    accepted = await a.accept();
  const bResult = await b.service.recommend({ ...a.target, connectionId: b.target.connectionId });
  expect(bResult.target.connectionId).toBe(b.target.connectionId);
  await expect(
    validateDraftKnowledgeAcceptance(repo, {
      receiptId: accepted.id,
      productKey: a.target.productKey,
      expectedRevision: 1,
      categoryId: '12',
      brandId: '3',
      scope: bResult.target.scope,
      attributeList: accepted.attributeList,
    }),
  ).rejects.toThrow('KNOWLEDGE_DRAFT_SCOPE_CHANGED');
});

it('rejects stale revisions before reading metadata and stale receipts after a draft edit', async () => {
  const f = await fixture(),
    accepted = await f.accept(),
    before = f.calls.length;
  await expect(f.service.recommend({ ...f.target, expectedRevision: 2 })).rejects.toThrow(
    'KNOWLEDGE_DRAFT_REVISION_CHANGED',
  );
  expect(f.calls.length).toBe(before);
  await pool.query('INSERT INTO product_revisions(product_key,revision,body) VALUES($1,2,$2)', [
    f.target.productKey,
    { ...f.draft, revision: 2 },
  ]);
  await pool.query('UPDATE products SET latest_revision=2 WHERE product_key=$1', [
    f.target.productKey,
  ]);
  await expect(
    validateDraftKnowledgeAcceptance(repo, {
      receiptId: accepted.id,
      productKey: f.target.productKey,
      expectedRevision: 1,
      categoryId: '12',
      brandId: '3',
      attributeList: accepted.attributeList,
    }),
  ).rejects.toThrow('KNOWLEDGE_DRAFT_REVISION_CHANGED');
});

it('expires acceptance and rejects metadata from another scope even if values match', async () => {
  const f = await fixture(),
    accepted = await f.accept();
  await expect(
    validateDraftKnowledgeAcceptance(
      repo,
      {
        receiptId: accepted.id,
        productKey: f.target.productKey,
        expectedRevision: 1,
        categoryId: '12',
        brandId: '3',
        attributeList: accepted.attributeList,
      },
      { now: () => f.getNow() + 16 * 60_000 },
    ),
  ).rejects.toThrow('KNOWLEDGE_DRAFT_METADATA_EXPIRED');
  const original = f.knowledge.getCategory.bind(f.knowledge);
  f.knowledge.getCategory = async (query) => ({
    ...(await original(query)),
    scope: {
      environment: 'production',
      partnerId: '9',
      shopId: 'different',
      connectionRevision: 1,
    },
  });
  await expect(f.service.recommend(f.target)).rejects.toThrow(
    'KNOWLEDGE_DRAFT_METADATA_SCOPE_CHANGED',
  );
});

it('rejects altered choices, changed fingerprint, connection revision, and idempotency payload reuse', async () => {
  const f = await fixture(),
    result = await f.service.recommend(f.target);
  await expect(
    f.service.accept({
      ...f.target,
      requestId: randomUUID(),
      recommendationFingerprint: '0'.repeat(64),
      attributeIds: [7],
    }),
  ).rejects.toThrow('KNOWLEDGE_DRAFT_RECOMMENDATION_CHANGED');
  const request = {
      ...f.target,
      requestId: randomUUID(),
      recommendationFingerprint: result.fingerprint,
      attributeIds: [7],
    },
    accepted = await f.service.accept(request);
  await expect(f.service.accept({ ...request, attributeIds: [8] })).rejects.toThrow(
    'KNOWLEDGE_DRAFT_REQUEST_CONFLICT',
  );
  const binding = {
    receiptId: accepted.id,
    productKey: f.target.productKey,
    expectedRevision: 1,
    categoryId: '12',
    brandId: '3',
    attributeList: [{ attribute_id: 7, attribute_value_list: [{ value_id: 9 }] }],
  };
  await expect(validateDraftKnowledgeAcceptance(repo, binding)).rejects.toThrow(
    'KNOWLEDGE_DRAFT_VALUES_CHANGED',
  );
  await pool.query('UPDATE connections SET revision=revision+1 WHERE id=$1', [
    f.target.connectionId,
  ]);
  await expect(
    validateDraftKnowledgeAcceptance(repo, { ...binding, attributeList: accepted.attributeList }),
  ).rejects.toThrow('KNOWLEDGE_DRAFT_CONNECTION_CHANGED');
});

it('serves revision-bound recommendations and explicit local acceptance through HTTP without a product write', async () => {
  const f = await fixture(),
    app = await createApp(
      repo,
      new BlobStore(resolve('.local/knowledge-draft-http', schema)),
      ['http://127.0.0.1:5173'],
      { sellerKnowledge: f.knowledge },
    );
  const headers = { origin: 'http://127.0.0.1:5173', 'x-app-client': 'internal-workspace' };
  try {
    const before = await repo.getProduct(f.target.productKey);
    const result = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/seller-knowledge/draft-recommendations',
        headers,
        payload: f.target,
      });
    expect(result.statusCode).toBe(201);
    const body = result.json();
    const accepted = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/seller-knowledge/draft-acceptances',
        headers,
        payload: {
          ...f.target,
          requestId: randomUUID(),
          recommendationFingerprint: body.fingerprint,
          attributeIds: [7],
        },
      });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({ localOnly: true, shopMutations: 0 });
    const stale = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/seller-knowledge/draft-recommendations',
        headers,
        payload: { ...f.target, expectedRevision: 2 },
      });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('KNOWLEDGE_DRAFT_REVISION_CHANGED');
    expect(await repo.getProduct(f.target.productKey)).toEqual(before);
  } finally {
    await app.close();
  }
});
