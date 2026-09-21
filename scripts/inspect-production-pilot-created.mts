import 'dotenv/config';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from '@shopee/persistence';
import { SecretBox } from '@shopee/gateway';
import { ProductionPilotTransport } from '../packages/shopee/src/production-pilot-transport.js';

// Read-only diagnosis for the one item already acknowledged by the authorized v4 create.
const scope = { environment: 'production', partnerId: '2010476', shopId: '1423724897' } as const;
const selectedSource = process.argv[2] ?? 'row-2';
if (!['row-2', 'row-65'].includes(selectedSource)) throw Error('CREATED_ITEM_SCOPE_MISMATCH');
const operationId = selectedSource === 'row-2' ? 'ec195c1c-b2e1-44d9-a866-e14a39988a9b' : '007738be-04ec-4ead-88d2-825062b29056',
  itemId = selectedSource === 'row-2' ? '51467852283' : '51267858328';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const directory = resolve('.local/production-pilot-1423724897/created-read-' + randomUUID());
try {
  const op = (
    await pool.query(
      'SELECT owner_key,connection_id,item_id,source_identity,source_revision FROM production_pilot_operations WHERE id=$1',
      [operationId],
    )
  ).rows[0];
  if (
    !op ||
    op.owner_key !== 'production:2010476:1423724897' ||
    op.item_id !== itemId ||
    op.source_identity !== 'fd983d71-dbe4-4980-a3d6-d2f90d9f117c:' + selectedSource ||
    op.source_revision !== 4
  )
    throw Error('CREATED_ITEM_SCOPE_MISMATCH');
  const connection = (await pool.query('SELECT * FROM connections WHERE id=$1', [op.connection_id]))
    .rows[0];
  if (
    !connection ||
    connection.environment !== scope.environment ||
    connection.partner_id !== scope.partnerId ||
    connection.shop_id !== scope.shopId ||
    connection.state !== 'connected' ||
    !connection.expires_at ||
    new Date(connection.expires_at).getTime() <= Date.now()
  )
    throw Error('CREATED_ITEM_READ_AUTH_REQUIRED');
  const owner = 'production:2010476:1423724897',
    box = new SecretBox(process.env.APP_ENCRYPTION_KEY ?? '');
  const key = box.open(connection.partner_key_ciphertext, owner) as { partnerKey: string };
  const token = box.open(connection.token_ciphertext, owner) as { accessToken: string };
  // No mutation callback is supplied: this client cannot obtain a write permit.
  const client = new ProductionPilotTransport({
    ...scope,
    partnerKey: key.partnerKey,
    accessToken: token.accessToken,
  });
  await mkdir(directory, { recursive: true });
  const summaries = [];
  for (let index = 1; index <= 2; index++) {
    if (index > 1) await new Promise((resolve) => setTimeout(resolve, 2500));
    const base = await client.read('/api/v2/product/get_item_base_info', { item_id_list: itemId });
    const models = await client.read('/api/v2/product/get_model_list', { item_id: itemId });
    const observedAt = new Date().toISOString();
    const receipt = {
      scope,
      operationId,
      itemId,
      connectionId: connection.id,
      connectionRevision: connection.revision,
      observedAt,
      base,
      models,
    };
    const bytes = JSON.stringify(receipt, null, 2),
      file = resolve(directory, 'read-' + index + '.json');
    await writeFile(file, bytes, { flag: 'wx' });
    if (base.kind !== 'success' || models.kind !== 'success') {
      summaries.push({ observedAt, file, baseKind: base.kind, modelsKind: models.kind });
      continue;
    }
    const item = (base.response as any).item_list?.find((i: any) => String(i.item_id) === itemId);
    const rows = (models.response as any).model;
    summaries.push({
      observedAt,
      file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      baseRequestId: base.requestId,
      modelsRequestId: models.requestId,
      itemStatus: item?.item_status,
      cover: item?.promotion_image,
      models: Array.isArray(rows)
        ? rows.map((m: any) => ({
            sku: m.model_sku,
            modelId: m.model_id,
            sellerStock: m.stock_info_v2?.seller_stock,
            summary: m.stock_info_v2?.summary_info,
            shopeeStock: m.stock_info_v2?.shopee_stock,
            advanceStock: m.stock_info_v2?.advance_stock,
          }))
        : null,
    });
  }
  await writeFile(
    resolve(directory, 'summary.json'),
    JSON.stringify({ scope, operationId, itemId, mutations: 0, summaries }, null, 2),
    { flag: 'wx' },
  );
  console.log(JSON.stringify({ directory, itemId, mutations: 0, summaries }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  console.error(/^[A-Z_]+$/.test(message) ? message : 'CREATED_ITEM_READ_FAILED');
  process.exitCode = 1;
} finally {
  await pool.end();
}
