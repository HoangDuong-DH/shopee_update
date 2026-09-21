import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { Pool, Repository, BlobStore, migrate } from '../../packages/persistence/src/index.js';
import { SellerKnowledgeService } from '../../apps/api/src/seller-knowledge-service.js';
import { createApp } from '../../apps/api/src/app.js';

const database = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '5442')
  throw Error('Isolated local PG required');
const schema = 'test_knowledge_http_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: database.href }),
  pool = new Pool({ connectionString: database.href, options: `-c search_path=${schema}` }),
  repo = new Repository(pool);
const connectionId = randomUUID(),
  otherConnectionId = randomUUID(),
  paths: string[] = [];
const service = new SellerKnowledgeService(repo, {
  autoRun: false,
  sleep: async () => {},
  read: async (_scope, path, query) => {
    paths.push(path);
    let response: any = {};
    if (path.endsWith('get_item_list'))
      response = {
        item:
          query.item_status === 'NORMAL'
            ? [
                { item_id: 11, item_status: 'NORMAL', update_time: 10 },
                { item_id: 12, item_status: 'NORMAL', update_time: 10 },
              ]
            : [],
        has_next_page: false,
      };
    if (path.endsWith('get_item_base_info'))
      response = {
        item_list: query
          .item_id_list!.split(',')
          .map((id) => ({
            item_id: Number(id),
            item_name: 'Sản phẩm ' + id,
            item_sku: 'SKU',
            category_id: 101127,
            brand: { brand_id: 5 },
            item_status: 'NORMAL',
            update_time: 10,
            has_model: false,
            attribute_list:
              id === '12'
                ? [
                    {
                      attribute_id: 100037,
                      attribute_value_list: [{ value_id: 136, original_value_name: 'Vietnam' }],
                    },
                  ]
                : [],
          })),
      };
    if (path.endsWith('get_category'))
      response = {
        category_list: [
          {
            category_id: 101127,
            parent_category_id: 0,
            display_category_name: 'Chất khử mùi',
            has_children: false,
          },
        ],
      };
    if (path.endsWith('get_attribute_tree'))
      response = {
        list: [
          {
            category_id: 101127,
            attribute_tree: [
              {
                attribute_id: 100037,
                name: 'Origin',
                mandatory: false,
                attribute_info: { input_type: 2, input_validation_type: 2, format_type: 1 },
                attribute_value_list: [{ value_id: 136, name: 'Vietnam' }],
              },
              {
                attribute_id: 102560,
                name: 'country of origins',
                mandatory: false,
                attribute_info: { input_type: 3, input_validation_type: 0, format_type: 1 },
              },
            ],
          },
        ],
      };
    return { kind: 'success', requestId: randomUUID(), response };
  },
});
let app: Awaited<ReturnType<typeof createApp>>, evidenceId: string;
const headers = { origin: 'http://127.0.0.1:5173', 'x-app-client': 'internal-workspace' };
const call = (args: any) => app.getHttpAdapter().getInstance().inject(args);
const outbound = vi
  .spyOn(globalThis, 'fetch')
  .mockRejectedValue(Error('External network forbidden in fixture'));
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  for (const [id, shop] of [
    [connectionId, '7'],
    [otherConnectionId, '8'],
  ])
    await pool.query(
      `INSERT INTO connections(id,environment,partner_id,shop_id,name,state,expires_at) VALUES($1,'production','9',$2,'Shop fixture','connected',now()+interval '1 hour')`,
      [id, shop],
    );
  const job = await service.startSync({ connectionId, requestId: randomUUID() });
  await service.runSync(job.id);
  evidenceId = (await service.search({ connectionId })).find(
    (row) => row.itemId === '11',
  )!.evidenceId;
  app = await createApp(
    repo,
    new BlobStore(resolve('.local/knowledge-http', schema)),
    ['http://127.0.0.1:5173'],
    { sellerKnowledge: service },
  );
});
afterAll(async () => {
  await app?.close();
  outbound.mockRestore();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
it('exposes real scoped stored products and metadata-driven reference suggestions with no writer', async () => {
  const search = await call({
    method: 'GET',
    url: '/v1/seller-knowledge/search?connectionId=' + connectionId,
  });
  expect(search.statusCode).toBe(200);
  expect(search.json().listings).toHaveLength(2);
  const res = await call({
    method: 'POST',
    url: '/v1/seller-knowledge/recommendations',
    headers,
    payload: { connectionId, evidenceId },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().shopMutations).toBe(0);
  expect(res.json().recommendations.suggestions[0]).toMatchObject({
    attributeId: 100037,
    canPrefill: false,
  });
  expect(paths.every((path) => path.includes('/get_'))).toBe(true);
});
it('rejects an evidence ID from another shop rather than treating it as target', async () => {
  const res = await call({
    method: 'POST',
    url: '/v1/seller-knowledge/recommendations',
    headers,
    payload: { connectionId: otherConnectionId, evidenceId },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().code).toBe('SELLER_KNOWLEDGE_SCOPE_MISMATCH');
});
it('persists confirmed text-field facts idempotently as local evidence, without editing observed listings', async () => {
  const before = await service.getEvidence(evidenceId),
    requestId = randomUUID();
  const payload = {
    connectionId,
    evidenceId,
    requestId,
    sourceReference: 'Người vận hành xác nhận xuất xứ cho đúng sản phẩm',
    facts: [{ attributeId: 102560, values: [{ valueId: 0, originalValueName: 'Việt Nam' }] }],
  };
  const first = await call({ method: 'POST', url: '/v1/seller-knowledge/facts', headers, payload });
  expect(first.statusCode).toBe(201);
  expect(first.json().localOnly).toBe(true);
  const second = await call({
    method: 'POST',
    url: '/v1/seller-knowledge/facts',
    headers,
    payload,
  });
  expect(second.json().id).toBe(first.json().id);
  const review = await call({
    method: 'POST',
    url: '/v1/seller-knowledge/recommendations',
    headers,
    payload: { connectionId, evidenceId },
  });
  expect(
    review.json().recommendations.suggestions.find((s: any) => s.attributeId === 102560),
  ).toMatchObject({ canPrefill: true, sourceClass: 'product_source' });
  expect(await service.getEvidence(evidenceId)).toEqual(before);
  const wrong = await call({
    method: 'POST',
    url: '/v1/seller-knowledge/facts',
    headers,
    payload: {
      ...payload,
      facts: [{ attributeId: 102560, values: [{ valueId: 0, originalValueName: 'Khác' }] }],
    },
  });
  expect(wrong.statusCode).toBe(409);
});
it('rejects fabricated values for unknown attributes and malformed requests', async () => {
  const bad = await call({
    method: 'POST',
    url: '/v1/seller-knowledge/facts',
    headers,
    payload: {
      connectionId,
      evidenceId,
      requestId: randomUUID(),
      sourceReference: 'Nguồn xác nhận',
      facts: [{ attributeId: 999999, values: [{ valueId: 0, originalValueName: 'Bất kỳ' }] }],
    },
  });
  expect(bad.statusCode).toBe(409);
  const request = await call({
    method: 'POST',
    url: '/v1/seller-knowledge/syncs',
    headers,
    payload: { connectionId, requestId: randomUUID(), maxItems: 501 },
  });
  expect(request.statusCode).toBe(400);
});
it('rejects stale target evidence after a newer observation becomes current but keeps history readable', async () => {
  const replacement = (await service.search({ connectionId })).find(
    (row) => row.itemId === '12',
  )!.evidenceId;
  await pool.query(
    'UPDATE seller_knowledge_items SET evidence_id=$1 WHERE connection_id=$2 AND item_id=$3',
    [replacement, connectionId, '11'],
  );
  try {
    for (const [url, payload] of [
      ['/v1/seller-knowledge/recommendations', { connectionId, evidenceId }],
      [
        '/v1/seller-knowledge/facts',
        {
          connectionId,
          evidenceId,
          requestId: randomUUID(),
          sourceReference: 'Xác nhận trên bản cũ',
          facts: [{ attributeId: 102560, values: [{ valueId: 0, originalValueName: 'Việt Nam' }] }],
        },
      ],
    ] as const) {
      const result = await call({ method: 'POST', url, headers, payload });
      expect(result.statusCode).toBe(409);
      expect(result.json().code).toBe('SELLER_KNOWLEDGE_TARGET_STALE');
    }
    expect(
      (await call({ method: 'GET', url: '/v1/seller-knowledge/evidence/' + evidenceId }))
        .statusCode,
    ).toBe(200);
  } finally {
    await pool.query(
      'UPDATE seller_knowledge_items SET evidence_id=$1 WHERE connection_id=$2 AND item_id=$3',
      [evidenceId, connectionId, '11'],
    );
  }
});
it('reports incomplete reference coverage when retrieval is bounded and preserves confirmed source facts', async () => {
  const coverage = vi
    .spyOn(service, 'getCandidateCoverage')
    .mockResolvedValue({ totalCount: 101, limit: 100, truncated: true });
  try {
    const response = await call({
      method: 'POST',
      url: '/v1/seller-knowledge/recommendations',
      headers,
      payload: { connectionId, evidenceId },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.candidateCoverage.truncated).toBe(true);
    expect(body.recommendations.issues).toContainEqual(
      expect.objectContaining({ code: 'CANDIDATE_COVERAGE_INCOMPLETE' }),
    );
    expect(
      body.recommendations.suggestions.find((s: any) => s.attributeId === 100037),
    ).toMatchObject({ canPrefill: false, confidence: 'blocked', values: [] });
    expect(
      body.recommendations.suggestions.find((s: any) => s.attributeId === 102560),
    ).toMatchObject({ sourceClass: 'product_source', canPrefill: true });
  } finally {
    coverage.mockRestore();
  }
});
