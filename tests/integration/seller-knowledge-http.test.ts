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
            image: {
              image_id_list: ['img-1', 'img-2'],
              image_url_list: [
                'https://example.invalid/1.jpg',
                'https://example.invalid/2.jpg',
              ],
            },
            has_promotion: id === '11',
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

it('serves an immutable scoped archive snapshot with explicit media and destination readiness', async () => {
  const archiveId = randomUUID();
  const proof = (await service.getEvidence(evidenceId))!;
  await pool.query(
    `INSERT INTO shop_listing_archives(
      id,connection_id,source_shop_id,name,selection,completed_at,item_count
    ) VALUES($1,$2,'7','HABY fixture',$3,now(),1)`,
    [archiveId, connectionId, { includedBrands: ['HABY', 'FAMONY', 'MOPPI'] }],
  );
  await pool.query(
    `INSERT INTO shop_listing_archive_items(
      archive_id,item_id,evidence_id,content_hash,item_status,title,brand_id,category_id,
      model_count,gallery_count,video_count
    ) VALUES($1,'11',$2,$3,'NORMAL','Sản phẩm 11','5','101127',0,2,0)`,
    [archiveId, evidenceId, proof.contentHash],
  );
  const blob = 'a'.repeat(64);
  await pool.query(
    `INSERT INTO shop_listing_media_blobs(sha256,byte_count,mime,storage_path)
      VALUES($1,10,'image/jpeg','fixture/aa')`,
    [blob],
  );
  await pool.query(
    `INSERT INTO shop_listing_media_refs(
      archive_id,item_id,role,ordinal,source_media_id,source_url,blob_sha256,state
    ) VALUES
      ($1,'11','gallery',0,'img-1','https://example.invalid/1.jpg',$2,'stored'),
      ($1,'11','gallery',1,'img-2','https://example.invalid/2.jpg',NULL,'pending')`,
    [archiveId, blob],
  );

  const archives = await call({ method: 'GET', url: '/v1/seller-knowledge/archives' });
  expect(archives.statusCode).toBe(200);
  expect(archives.json()).toContainEqual(
    expect.objectContaining({ id: archiveId, sourceShopId: '7', itemCount: 1 }),
  );
  const items = await call({
    method: 'GET',
    url: `/v1/seller-knowledge/archives/${archiveId}/items?limit=1`,
  });
  expect(items.statusCode).toBe(200);
  expect(items.json()).toEqual([
    expect.objectContaining({ itemId: '11', evidenceId, modelCount: 0 }),
  ]);
  const url = `/v1/seller-knowledge/archives/${archiveId}/items/11`;
  const pending = await call({ method: 'GET', url });
  expect(pending.statusCode).toBe(200);
  expect(pending.json()).toMatchObject({
    sourceShopId: '7',
    sourceConnectionId: connectionId,
    sourceSelection: { includedBrands: ['HABY', 'FAMONY', 'MOPPI'] },
    archiveComplete: true,
    rawItem: proof.body.rawItem,
    rawModels: null,
    mediaRefsExpected: 2,
    mediaRefsStored: 1,
    mediaRefsPending: 1,
    mediaRefsFailed: 0,
    mediaCaptureComplete: false,
    sourceHasPromotion: true,
    promotionCaptureComplete: false,
    canCopyNow: false,
    copyReadiness: 'blocked',
  });

  await pool.query(
    `UPDATE shop_listing_media_refs SET state='stored',blob_sha256=$3,fetched_at=now()
      WHERE archive_id=$1 AND item_id=$2 AND ordinal=1`,
    [archiveId, '11', blob],
  );
  const captured = await call({ method: 'GET', url });
  expect(captured.json()).toMatchObject({
    mediaRefsStored: 2,
    mediaRefsPending: 0,
    mediaCaptureComplete: true,
    promotionCaptureComplete: false,
    copyReadiness: 'blocked',
  });
  expect(captured.json().mediaRefs).toHaveLength(2);
  expect(captured.json().copyBlockers).toContain('source_promotion_capture_incomplete');
  await pool.query(
    `INSERT INTO shop_listing_archive_aux(
      archive_id,item_id,kind,content_hash,body,observed_at
    ) VALUES($1,'11','promotion',$2,$3,now())`,
    [
      archiveId,
      'b'.repeat(64),
      {
        path: '/api/v2/product/get_item_promotion',
        sourceShopId: '7',
        itemId: '11',
        response: { success_list: [{ item_id: 11, promotion: [] }] },
      },
    ],
  );
  const promoted = await call({ method: 'GET', url });
  expect(promoted.json()).toMatchObject({
    sourceHasPromotion: true,
    promotionCaptureComplete: true,
    promotionSnapshot: {
      contentHash: 'b'.repeat(64),
      response: { success_list: [{ item_id: 11, promotion: [] }] },
    },
    promotionTransferPolicy: 'target_shop_reconciliation_required',
    mediaCaptureComplete: true,
    canCopyNow: false,
    copyReadiness: 'blocked',
  });
  expect(promoted.json().copyBlockers).not.toContain('source_promotion_capture_incomplete');
  expect(promoted.json().copyBlockers).toContain(
    'target_shop_brand_category_logistics_promotion_variation_preflight_required',
  );
  await pool.query(
    `DELETE FROM shop_listing_media_refs
      WHERE archive_id=$1 AND item_id='11' AND role='gallery' AND ordinal=1`,
    [archiveId],
  );
  const incomplete = await call({ method: 'GET', url });
  expect(incomplete.json()).toMatchObject({
    mediaRefsExpected: 2,
    mediaRefsRegistered: 1,
    mediaRefsUnregistered: 1,
    mediaSourceMatched: false,
    mediaCaptureComplete: false,
    canCopyNow: false,
  });
  await pool.query(
    `INSERT INTO shop_listing_media_refs(
      archive_id,item_id,role,ordinal,source_media_id,source_url,blob_sha256,state
    ) VALUES($1,'11','gallery',1,'img-2','https://example.invalid/2.jpg',$2,'stored')`,
    [archiveId, blob],
  );
  expect(paths.every((path) => path.includes('/get_'))).toBe(true);

  // A source archive cannot be reinterpreted as another connected shop.
  await pool.query('UPDATE shop_listing_archives SET source_shop_id=$2 WHERE id=$1', [
    archiveId,
    '8',
  ]);
  try {
    expect(
      (await call({ method: 'GET', url: '/v1/seller-knowledge/archives' }))
        .json().some((entry: any) => entry.id === archiveId),
    ).toBe(false);
    const mismatch = await call({ method: 'GET', url });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().code).toBe('KNOWLEDGE_ARCHIVE_SCOPE_MISMATCH');
  } finally {
    await pool.query('UPDATE shop_listing_archives SET source_shop_id=$2 WHERE id=$1', [
      archiveId,
      '7',
    ]);
  }
});
it('saves four selected destination shops as a versioned plan without authorizing writes', async () => {
  const archiveId = randomUUID();
  await pool.query(
    `INSERT INTO shop_listing_archives(
      id,connection_id,source_shop_id,name,selection,completed_at,item_count
    ) VALUES($1,$2,'7','Copy-plan fixture','{}',now(),0)`,
    [archiveId, connectionId],
  );
  const url = `/v1/seller-knowledge/archives/${archiveId}/copy-plan`;
  const empty = await call({ method: 'GET', url });
  expect(empty.statusCode).toBe(200);
  expect(empty.json()).toMatchObject({
    archiveId,
    sourceShopId: '7',
    sourcePartnerId: '9',
    targets: [],
    revision: 0,
    updatedAt: null,
  });
  const targets = [
    { partnerId: '2010476', shopId: '1376860967', displayName: 'CleanZ Việt Nam Chính Hãng' },
    { partnerId: '2010476', shopId: '1293590748', displayName: 'Earth Choice Việt Nam' },
    { partnerId: '2010476', shopId: '966101536', displayName: 'Hygge - Chăm sóc Gia đình' },
    { partnerId: '2010476', shopId: '978266921', displayName: 'ThaiCare VN' },
  ];
  const save = (expectedRevision: number, selected: typeof targets) =>
    call({
      method: 'POST',
      url,
      headers,
      payload: { expectedRevision, targets: selected },
    });
  const saved = await save(0, targets);
  expect(saved.statusCode).toBe(201);
  expect(saved.json()).toMatchObject({
    archiveId,
    targets,
    revision: 1,
  });
  expect((await call({ method: 'GET', url })).json()).toMatchObject({
    archiveId,
    targets,
    revision: 1,
  });
  expect(
    (await pool.query('SELECT targets,revision FROM shop_listing_copy_plans WHERE archive_id=$1', [
      archiveId,
    ])).rows[0],
  ).toMatchObject({ targets, revision: 1 });

  const stale = await save(0, targets.slice(0, 1));
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe('KNOWLEDGE_COPY_PLAN_REVISION_CONFLICT');
  const duplicate = await save(1, [targets[0]!, targets[0]!]);
  expect(duplicate.statusCode).toBe(409);
  expect(duplicate.json().code).toBe('KNOWLEDGE_COPY_PLAN_DUPLICATE_TARGET');
  const sourceAsTarget = await save(1, [{ partnerId: '9', shopId: '7', displayName: 'Source' }]);
  expect(sourceAsTarget.statusCode).toBe(409);
  expect(sourceAsTarget.json().code).toBe('KNOWLEDGE_COPY_PLAN_SOURCE_IS_TARGET');
  expect((await call({ method: 'GET', url })).json()).toMatchObject({
    targets,
    revision: 1,
  });
  expect(outbound).not.toHaveBeenCalled();
});