import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { Pool, Repository, BlobStore } from '../packages/persistence/src/index.js';
import {
  SecretBox,
  SandboxPreparedTransport,
  fetchObservedShopeeImage,
  pollPreparedReadback,
} from '../packages/shopee/src/index.js';
import { ImageQcService } from '../apps/api/src/image-qc-service.js';
import { checkPreparedWireUpdateWithImageQc } from '../apps/api/src/prepared-image-qc.js';
const root = '.local/acceptance-20260914/variation-qc/image-cases',
  file = root + '/cover-restore-reconciliation.json';
if (
  await access(file).then(
    () => true,
    () => false,
  )
)
  throw new Error('RECONCILIATION_ALREADY_RECORDED');
const saved = JSON.parse(await readFile(root + '/cover-restore.json', 'utf8'));
const historicalRoot = '.local/acceptance-20260914/patch-matrix/live/cover-restore';
const intent = JSON.parse(await readFile(historicalRoot + '/intent.json', 'utf8'));
const identity = JSON.parse(await readFile(historicalRoot + '/cover-identity.json', 'utf8'));
if (
  saved.binding.itemId !== '803935036' ||
  saved.binding.operationId !== intent.id ||
  saved.binding.environment !== 'sandbox'
)
  throw new Error('BOUND_TECHNICAL_CASE_REQUIRED');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const row = (await pool.query('SELECT * FROM connections WHERE id=$1', [intent.connectionId]))
    .rows[0];
  if (
    row?.environment !== 'sandbox' ||
    row.partner_id !== '1232297' ||
    row.shop_id !== '227418363' ||
    row.state !== 'connected'
  )
    throw new Error('TEST_CONNECTION_REQUIRED');
  const owner = 'sandbox:1232297:227418363',
    box = new SecretBox(process.env.APP_ENCRYPTION_KEY ?? '');
  const secrets = {
    ...(box.open(row.partner_key_ciphertext, owner) as any),
    ...(box.open(row.token_ciphertext, owner) as any),
  };
  const client = new SandboxPreparedTransport(
    {
      environment: 'sandbox',
      partnerId: row.partner_id,
      shopId: row.shop_id,
      partnerKey: secrets.partnerKey,
      accessToken: secrets.accessToken,
    },
    [{ partnerId: '1232297', shopId: '227418363' }],
  );
  const service = new ImageQcService(
    new Repository(pool),
    new BlobStore(process.env.DATA_ROOT ?? '.local/data'),
  );
  const original = identity.images.find((r: any) => r.name === 'before');
  const source = await fetchObservedShopeeImage({
    url: original.url,
    observedUrls: identity.images.map((r: any) => r.url),
  });
  if (source.state !== 'fetched' || source.sha256 !== saved.sourceSha256)
    throw new Error('SOURCE_BYTES_CHANGED');
  const observe = async (signal?: AbortSignal) => {
    const base = await client.read(
      '/api/v2/product/get_item_base_info',
      { item_id_list: '803935036', need_tax_info: 'true', need_complaint_policy: 'true' },
      signal,
    );
    if (base.kind !== 'success') return base;
    const items = base.response.item_list as any[];
    if (
      items?.length !== 1 ||
      items[0].item_id !== 803935036 ||
      items[0].item_status !== 'UNLIST' ||
      items[0].has_model !== false
    )
      throw new Error('TECHNICAL_ITEM_CHANGED');
    const pic = items[0].promotion_image;
    if (
      pic?.image_id_list?.length !== 1 ||
      pic.image_id_list[0] !== saved.binding.outputImageId ||
      pic.image_url_list?.length !== 1
    )
      throw new Error('OUTPUT_SLOT_CHANGED');
    const output = await fetchObservedShopeeImage({
      url: pic.image_url_list[0],
      observedUrls: pic.image_url_list,
    });
    if (output.state !== 'fetched' || output.sha256 !== saved.outputSha256)
      throw new Error('OUTPUT_BYTES_CHANGED');
    const after = { item: items[0], models: { model: [], tier_variation: [] } };
    const checked = await checkPreparedWireUpdateWithImageQc(service, {
      operationId: intent.id,
      scope: intent.scope,
      before: intent.before.snapshot,
      steps: [intent.step],
      after,
      cover: {
        caseId: saved.id,
        sourceAssetId: saved.binding.sourceAssetId,
        sourceBaselineImageId: original.imageId,
        source: { imageId: original.imageId, bytes: source.bytes },
        output: { imageId: pic.image_id_list[0], bytes: output.bytes },
      },
    });
    return { kind: 'success' as const, response: { after, checked }, requestId: base.requestId };
  };
  const pending = await observe();
  if (
    pending.kind !== 'success' ||
    pending.response.checked.reason !== 'IMAGE_QC_REVIEW_NOT_VERIFIED'
  )
    throw new Error('EXPECTED_SCOPED_REVIEW_REQUIRED');
  const review = await service.review({
    id: saved.id,
    requestId: randomUUID(),
    expectedFingerprint: saved.fingerprint,
    binding: saved.binding,
    decision: 'accept_lossy_match',
    reviewer: 'Codex QA (agent)',
    note: 'Hai agent đối chiếu ảnh đầy đủ: cùng hình sổ, chữ SANDBOX QA, mã bộ thử, bố cục và mép ảnh; khác điểm ảnh do mã JPEG Shopee lưu lại. Đây là kết luận kiểm thử của agent, không phải xác nhận của nhân viên.',
  });
  const readback = await pollPreparedReadback({
    read: observe,
    check: (r) => ({ verified: r.checked.verified, mismatchedPaths: r.checked.mismatchedPaths }),
    delaysMs: [0, 1000, 2000, 3000],
    timeoutMs: 45000,
  });
  const result = {
    observedAt: new Date().toISOString(),
    scope: 'read-only sandbox reconciliation; local image review only; no Shopee mutation',
    historicalWireOperationUnchanged: true,
    review,
    pending,
    readback,
  };
  await writeFile(file, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(
    JSON.stringify({
      state: readback.state,
      imageReview: review.result.verificationBasis,
      observations: readback.observations.map((r) => ({
        verified: r.verified,
        paths: r.mismatchedPaths,
        requestId: r.requestId,
      })),
    }),
  );
} finally {
  await pool.end();
}
