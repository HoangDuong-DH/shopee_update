import 'dotenv/config';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { Pool, Repository } from '../packages/persistence/src/index.js';
import { SecretBox } from '../packages/shopee/src/secret-box.js';
import { SandboxPreparedTransport } from '../packages/shopee/src/prepared-transport.js';
import {
  normalizePreparedWireSnapshot,
  type PreparedWireStep,
} from '../packages/shopee/src/prepared-wire.js';
import { checkPreparedWireUpdate } from '../packages/shopee/src/prepared-wire-qc.js';
import { pollPreparedReadback } from '../packages/shopee/src/prepared-readback.js';
import { PreparedWireRunner } from '../apps/api/src/prepared-wire-runner.js';
import { canonicalJson } from '../packages/domain/src/index.js';
import type { FieldSnapshot } from '../packages/shopee/src/field-client.js';

const caseName = process.argv.find((v) => v.startsWith('--case='))?.slice(7);
const cases = {
  'stock-zero-two': '803934787',
  'stock-zero-one': '803934786',
  'variation-two': '803934787',
  'variation-one': '803934786',
  'gallery-portrait': '803935036',
  'cover-new': '803935036',
  'cover-restore': '803935036',
  'gallery-reorder': '803935036',
};
if (!caseName || !(caseName in cases)) throw new Error('EXPLICIT_CASE_REQUIRED');
const target = cases[caseName as keyof typeof cases];
const execute = process.argv.includes('--execute');
const root = '.local/acceptance-20260914/patch-matrix/live';
const folder = join(root, caseName);
const sourceFolder =
  '.local/acceptance-20260914/prepared-wire/run-mY5s0W/80-business-listings/001 - QA Văn phòng phẩm - QA Shop Bắc';
const allowed = [{ partnerId: '1232297', shopId: '227418363' }];
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const digest = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const exists = async (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
try {
  if (await exists(join(folder, 'result.json')))
    throw new Error('CASE_ALREADY_RECORDED_DO_NOT_REPLAY');
  await mkdir(folder, { recursive: true });
  const binding = (
    await pool.query(
      "SELECT * FROM sandbox_create_trial_items WHERE item_id=$1 AND state='verified' AND stage='done'",
      [target],
    )
  ).rows[0];
  if (!binding?.source_key.startsWith('SBX-BULK-')) throw new Error('TECHNICAL_BINDING_REQUIRED');
  const row = (await pool.query('SELECT * FROM connections WHERE id=$1', [binding.connection_id]))
    .rows[0];
  if (
    !row ||
    row.environment !== 'sandbox' ||
    row.partner_id !== '1232297' ||
    row.shop_id !== '227418363' ||
    row.state !== 'connected'
  )
    throw new Error('TEST_SCOPE_REQUIRED');
  const box = new SecretBox(process.env.APP_ENCRYPTION_KEY ?? ''),
    owner = 'sandbox:1232297:227418363';
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
    allowed,
  );
  const read = async () => {
    const base = await client.read('/api/v2/product/get_item_base_info', {
      item_id_list: target,
      need_tax_info: 'true',
      need_complaint_policy: 'true',
    });
    if (base.kind !== 'success') throw new Error('TEST_BASE_READ_FAILED');
    const items = base.response.item_list as any[];
    if (
      items?.length !== 1 ||
      String(items[0].item_id) !== target ||
      items[0].item_sku !== binding.source_key ||
      items[0].item_status !== 'UNLIST' ||
      !items[0].item_name.startsWith('SANDBOX QA ')
    )
      throw new Error('TEST_TARGET_CHANGED');
    let models: any = { model: [], tier_variation: [] },
      requestId = base.requestId;
    if (items[0].has_model === true) {
      const result = await client.read('/api/v2/product/get_model_list', { item_id: target });
      if (result.kind !== 'success') throw new Error('TEST_MODEL_READ_FAILED');
      models = result.response;
      requestId += ':' + result.requestId;
    } else if (items[0].has_model !== false) throw new Error('MODEL_PRESENCE_UNKNOWN');
    return { snapshot: { item: items[0], models } as FieldSnapshot, requestId };
  };
  const upload = async (filename: string, ratio: '1:1' | '3:4') => {
    if (!execute) return 'PREVIEW_NOT_UPLOADED';
    const artifact = join(folder, 'upload-' + filename + '.json');
    const file = join(sourceFolder, filename),
      bytes = await readFile(file),
      meta = await sharp(bytes).metadata();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (meta.width !== 900 || meta.height !== (ratio === '1:1' ? 900 : 1200))
      throw new Error('SOURCE_IMAGE_RATIO_CHANGED');
    if (await exists(artifact)) {
      const old = JSON.parse(await readFile(artifact, 'utf8'));
      if (old.sha256 !== sha256 || old.result?.kind !== 'success' || !old.imageId)
        throw new Error('UPLOAD_UNRESOLVED_DO_NOT_REPEAT');
      return old.imageId as string;
    }
    await writeFile(
      artifact,
      JSON.stringify({
        state: 'sent',
        file,
        sha256,
        ratio,
        width: meta.width,
        height: meta.height,
      }),
      { flag: 'wx' },
    );
    const result = await client.upload(bytes, 'image/png', { scene: 'normal', ratio });
    const imageId =
      result.kind === 'success' ? (result.response.image_info as any)?.image_id : null;
    await writeFile(
      artifact,
      JSON.stringify(
        { file, sha256, ratio, width: meta.width, height: meta.height, result, imageId },
        null,
        2,
      ),
    );
    if (typeof imageId !== 'string' || !imageId) throw new Error('UPLOAD_UNRESOLVED_DO_NOT_REPEAT');
    return imageId;
  };
  let intent: any;
  if (await exists(join(folder, 'intent.json')))
    intent = JSON.parse(await readFile(join(folder, 'intent.json'), 'utf8'));
  else {
    const before = await read(),
      expected = structuredClone(before.snapshot),
      itemId = Number(target);
    let step: PreparedWireStep;
    if (caseName.startsWith('stock-zero')) {
      const selected = (expected.models.model as any[]).find((m) =>
        m.tier_index.every((i: number) => i === 0),
      );
      const stock = selected?.stock_info_v2;
      if (
        !stock ||
        stock.seller_stock.length !== 1 ||
        stock.seller_stock[0].stock === 0 ||
        stock.summary_info.total_reserved_stock !== 0 ||
        stock.seller_stock[0].location_id !== 'VNZ'
      )
        throw new Error('STOCK_CASE_BASELINE_UNSUPPORTED');
      step = {
        path: '/api/v2/product/update_stock',
        method: 'POST',
        group: 'stock',
        expectedModelIds: [String(selected.model_id)],
        payload: {
          item_id: itemId,
          stock_list: [
            { model_id: selected.model_id, seller_stock: [{ location_id: 'VNZ', stock: 0 }] },
          ],
        },
      };
      stock.seller_stock[0].stock = 0;
      stock.summary_info.total_available_stock = 0;
    } else if (caseName.startsWith('variation')) {
      const standards = expected.models.standardise_tier_variation as any[];
      if (standards?.length !== (caseName === 'variation-two' ? 2 : 1))
        throw new Error('VARIATION_BASELINE_UNSUPPORTED');
      const imageId = (expected.item.image as any).image_id_list[0];
      if (standards[0].variation_option_list[0].image_id === imageId)
        throw new Error('VARIATION_ALREADY_MATCHED');
      standards[0].variation_option_list[0].image_id = imageId;
      (expected.models.tier_variation[0] as any).option_list[0].image.image_id = imageId;
      step = {
        path: '/api/v2/product/update_tier_variation',
        method: 'POST',
        group: 'variationImages',
        payload: {
          item_id: itemId,
          standardise_tier_variation: standards.map((t) => ({
            variation_id: t.variation_id,
            variation_name: t.variation_name,
            ...(t.variation_group_id === undefined
              ? {}
              : { variation_group_id: t.variation_group_id }),
            variation_option_list: t.variation_option_list.map((o: any) => ({
              variation_option_id: o.variation_option_id,
              variation_option_name: o.variation_option_name,
              ...(o.image_id ? { image_id: o.image_id } : {}),
            })),
          })),
          model_list: expected.models.model.map((m) => ({
            model_id: m.model_id,
            tier_index: m.tier_index,
          })),
        },
      };
    } else {
      const image = expected.item.image as any,
        cover = expected.item.promotion_image as any;
      if (caseName === 'gallery-portrait') {
        if (
          image.image_ratio !== '1:1' ||
          cover.image_id_list.length !== 1 ||
          cover.image_id_list[0] !== image.image_id_list[0]
        )
          throw new Error('GALLERY_TRANSITION_BASELINE_REQUIRED');
        const ids = [
          await upload('Chi tiết 01.png', '3:4'),
          await upload('Chi tiết 02.png', '3:4'),
          await upload('Chi tiết 03.png', '3:4'),
        ];
        image.image_id_list = ids;
        image.image_ratio = '3:4';
      } else if (caseName === 'cover-new' || caseName === 'cover-restore') {
        if (image.image_ratio !== '3:4') throw new Error('GALLERY_34_REQUIRED');
        cover.image_id_list =
          caseName === 'cover-restore'
            ? JSON.parse(await readFile(join(root, 'gallery-portrait/intent.json'), 'utf8')).before
                .snapshot.item.promotion_image.image_id_list
            : [await upload('Ảnh bìa.png', '1:1')];
      } else {
        if (image.image_ratio !== '3:4' || image.image_id_list.length !== 3)
          throw new Error('GALLERY_34_REQUIRED');
        [image.image_id_list[1], image.image_id_list[2]] = [
          image.image_id_list[2],
          image.image_id_list[1],
        ];
      }
      step = {
        path: '/api/v2/product/update_item',
        method: 'POST',
        group: caseName.startsWith('cover-') ? 'cover' : 'gallery',
        payload: {
          item_id: itemId,
          ...(caseName.startsWith('cover-')
            ? {}
            : { image: { image_id_list: image.image_id_list, image_ratio: image.image_ratio } }),
          promotion_images: { image_id_list: cover.image_id_list },
        },
      };
    }
    const preflightQc = checkPreparedWireUpdate(before.snapshot, expected, [step]);
    if (!preflightQc.verified) {
      await writeFile(
        join(folder, 'preflight-blocked.json'),
        JSON.stringify({ before, expected, step, preflightQc }, null, 2),
      );
      throw new Error('READBACK_CONTRACT_UNSUPPORTED_' + preflightQc.mismatchedPaths.join(','));
    }
    intent = {
      id: randomUUID(),
      caseName,
      itemId: target,
      sourceKey: binding.source_key,
      observedAt: new Date().toISOString(),
      connectionId: row.id,
      scope: {
        environment: 'sandbox',
        partnerId: row.partner_id,
        shopId: row.shop_id,
        connectionRevision: row.revision,
        capabilityRevision: row.capability_revision,
      },
      before,
      expected,
      step,
    };
    if (!execute) {
      console.log(JSON.stringify({ caseName, itemId: target, preflightQc, previewOnly: true }));
      process.exitCode = 0;
    } else
      await writeFile(join(folder, 'intent.json'), JSON.stringify(intent, null, 2), { flag: 'wx' });
  }
  if (execute) {
    const current = await read();
    if (
      digest(normalizePreparedWireSnapshot(current.snapshot)) !==
      digest(normalizePreparedWireSnapshot(intent.before.snapshot))
    )
      throw new Error('STALE_BASELINE_DO_NOT_DISPATCH');
    const runner = new PreparedWireRunner(new Repository(pool), { allowedShops: allowed });
    const job = await runner.prepare({
      id: intent.id,
      connectionId: intent.connectionId,
      scope: intent.scope,
      sourceKey: intent.sourceKey,
      sourceFingerprint: digest({
        expected: intent.expected,
        before: intent.before.snapshot,
        caseName,
      }),
      plan: { kind: 'ready', operation: 'update', steps: [intent.step] },
    });
    if (job.state !== 'prepared') throw new Error('PREVIOUS_DISPATCH_DO_NOT_REPLAY');
    const start = Date.now(),
      execution = await runner.run(job.id);
    const readback = await pollPreparedReadback({
      read: async () => {
        const value = await read();
        return { kind: 'success', response: value.snapshot, requestId: value.requestId };
      },
      check: (after) => checkPreparedWireUpdate(intent.before.snapshot, after, [intent.step]),
      delaysMs: [0, 1000, 3000, 5000],
      timeoutMs: 30000,
    });
    const verified = execution.state === 'acknowledged' && readback.state === 'verified';
    const result = {
      observedAt: new Date().toISOString(),
      mode: 'live-sandbox-technical-patch',
      caseName,
      itemId: target,
      operationId: job.id,
      execution,
      readback,
      verified,
      durationMs: Date.now() - start,
    };
    await writeFile(join(folder, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
    console.log(
      JSON.stringify({
        folder,
        caseName,
        itemId: target,
        operationId: job.id,
        state: execution.state,
        verified,
        durationMs: result.durationMs,
        mismatchedPaths: readback.observations.at(-1)?.mismatchedPaths,
      }),
    );
    if (!verified) process.exitCode = 2;
  }
} finally {
  await pool.end();
}
