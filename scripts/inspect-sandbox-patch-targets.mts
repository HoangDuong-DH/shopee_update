import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from '../packages/persistence/src/index.js';
import { SecretBox } from '../packages/shopee/src/secret-box.js';
import { SandboxPreparedTransport } from '../packages/shopee/src/prepared-transport.js';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const folder = '.local/acceptance-20260914/patch-matrix/live';
try {
  const row = (
    await pool.query(
      "SELECT * FROM connections WHERE environment='sandbox' AND partner_id='1232297' AND shop_id='227418363'",
    )
  ).rows[0];
  if (!row || row.state !== 'connected') throw new Error('TEST_CONNECTION_REQUIRED');
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
  const results = [];
  for (const itemId of ['803935036', '803934786', '803934787']) {
    const binding = (
      await pool.query(
        "SELECT source_key FROM sandbox_create_trial_items WHERE item_id=$1 AND state='verified' AND stage='done'",
        [itemId],
      )
    ).rows[0];
    if (!binding?.source_key.startsWith('SBX-BULK-')) throw new Error('TECHNICAL_BINDING_REQUIRED');
    const base = await client.read('/api/v2/product/get_item_base_info', {
      item_id_list: itemId,
      need_tax_info: 'true',
      need_complaint_policy: 'true',
    });
    if (base.kind !== 'success') throw new Error('TEST_READ_' + base.code);
    const item = (base.response.item_list as any[])?.[0];
    if (
      String(item?.item_id) !== itemId ||
      item.item_sku !== binding.source_key ||
      item.item_status !== 'UNLIST' ||
      !item.item_name.startsWith('SANDBOX QA ')
    )
      throw new Error('TEST_TARGET_CHANGED');
    const models = item.has_model
      ? await client.read('/api/v2/product/get_model_list', { item_id: itemId })
      : null;
    if (models && models.kind !== 'success') throw new Error('TEST_MODEL_READ_FAILED');
    const promotions = await client.read('/api/v2/product/get_item_promotion', {
      item_id_list: itemId,
    });
    results.push({ itemId, sourceKey: binding.source_key, base, models, promotions });
  }
  await mkdir(folder, { recursive: true });
  const report = {
    observedAt: new Date().toISOString(),
    connectionId: row.id,
    revision: row.revision,
    capabilityRevision: row.capability_revision,
    mode: 'live-sandbox-readonly',
    mutations: 0,
    results,
  };
  await writeFile(folder + '/targets-before.json', JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(
    JSON.stringify({
      folder,
      revision: row.revision,
      mutations: 0,
      items: results.map((r) => {
        const item = (r.base as any).response.item_list[0];
        return {
          itemId: r.itemId,
          image: item.image,
          promotion_image: item.promotion_image,
          has_model: item.has_model,
          models: r.models?.kind === 'success' ? r.models.response : null,
          promotion: r.promotions,
        };
      }),
    }),
  );
} finally {
  await pool.end();
}
